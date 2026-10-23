import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Schema } from "effect"
import { basename } from "node:path"
import type { Rollup } from "vite"
import { clientSources, misplacedLocalHalves } from "./auctionLocalHalves.ts"
import { buildDeployment, buildEntry } from "./build.ts"

class BundleCheckFailure extends Schema.TaggedError<BundleCheckFailure>()("BundleCheckFailure", {
  deployment: Schema.String,
  message: Schema.String
}) {}

/**
 * Every page but `devtools` runs the wallet in the browser, so every other bundle keeps
 * `layerModelLocal` and `layerActionRunnerLocal` of `@mufw/core`: they say nothing about the auction. What does is where
 * the auction's local halves are built, `src/client/placements/auctionLocal.ts`: its exports are
 * names the bundler reports as kept (`renderedExports`), and they survive minification because the
 * bundler reports them before it renames anything. A half built outside that module is not seen in
 * a bundle; `checkLocalHalvesSource` finds it in the source of the client.
 */
const AUCTION_MODEL_LOCAL = "auctionModelLocal"
const AUCTION_ACTION_RUNNER_LOCAL = "auctionActionRunnerLocal"
/** The whole loop of the auction, which only a worker that serves it builds. */
const AUCTION_LOOP_LOCAL = "auctionLoopLocal"

/** The wallet's placement, which every deployment must keep: the control that the names above are not stale. */
const WALLET_LOCAL = "walletBrowserOnly"

/** The auction's view, which every page but `devtools` mounts (`runPage`): the control for its absence from `devtools`. */
const AUCTION_VIEW = "makeView"

/** The panels of `@mufw/devtools`: the `devtools` deployment ships the list without travel, no other one does. */
const HISTORY_LIST = "layerHistoryList"
const TIME_TRAVEL_PANEL = "layerPanel"

/** What a bundle must keep (`present`) and must not (`absent`), by the names it reports as kept. */
interface Shipped {
  readonly present: ReadonlyArray<string>
  readonly absent: ReadonlyArray<string>
}

/**
 * What each deployment must and must not ship. The `present` entries are the control: a deployment
 * that does run the half locally must show it, otherwise the check would pass on a stale name.
 * A page's build emits its worker as an opaque file, so a deployment with a `worker` is checked
 * twice: the page's own bundle, and the worker's module graph built from its entry.
 */
const expectations: ReadonlyArray<
  Shipped & {
    readonly deployment: string
    readonly worker?: Shipped & { readonly entry: string }
  }
> = [
  {
    deployment: "server-owned",
    present: [WALLET_LOCAL, AUCTION_VIEW],
    absent: [AUCTION_MODEL_LOCAL, AUCTION_ACTION_RUNNER_LOCAL, HISTORY_LIST]
  },
  {
    deployment: "browser-only",
    present: [WALLET_LOCAL, AUCTION_VIEW, AUCTION_MODEL_LOCAL, AUCTION_ACTION_RUNNER_LOCAL],
    absent: [HISTORY_LIST]
  },
  {
    deployment: "server-model",
    present: [WALLET_LOCAL, AUCTION_VIEW, AUCTION_ACTION_RUNNER_LOCAL],
    absent: [AUCTION_MODEL_LOCAL, HISTORY_LIST]
  },
  {
    deployment: "server-actions",
    present: [WALLET_LOCAL, AUCTION_VIEW, AUCTION_MODEL_LOCAL],
    absent: [AUCTION_ACTION_RUNNER_LOCAL, HISTORY_LIST]
  },
  {
    deployment: "devtools",
    present: [HISTORY_LIST],
    absent: [AUCTION_MODEL_LOCAL, AUCTION_ACTION_RUNNER_LOCAL, WALLET_LOCAL, AUCTION_VIEW, TIME_TRAVEL_PANEL]
  },
  {
    deployment: "worker",
    present: [WALLET_LOCAL, AUCTION_VIEW],
    absent: [AUCTION_MODEL_LOCAL, AUCTION_ACTION_RUNNER_LOCAL, AUCTION_LOOP_LOCAL, HISTORY_LIST],
    worker: {
      entry: "src/client/auctionWorker.ts",
      present: [AUCTION_LOOP_LOCAL],
      absent: [WALLET_LOCAL, AUCTION_VIEW]
    }
  }
]

const keptNames = (outputs: ReadonlyArray<Rollup.RollupOutput>) =>
  new Set(
    outputs
      .flatMap((bundle) => bundle.output)
      .flatMap((file) => file.type === "chunk" ? Object.values(file.modules) : [])
      .flatMap((module) => module.renderedExports)
  )

const mismatches = (kept: ReadonlySet<string>, expected: Shipped) => [
  ...expected.absent.filter((name) => kept.has(name)).map((name) => `ships ${name}`),
  ...expected.present.filter((name) => !kept.has(name)).map((name) => `lacks ${name}`)
]

/** The page's build emits its worker as a file named after the worker's entry; a build that emitted none has lost the worker. */
const emitsWorkerFile = (outputs: ReadonlyArray<Rollup.RollupOutput>, entry: string) =>
  outputs
    .flatMap((bundle) => bundle.output)
    .some((file) => file.type === "asset" && file.fileName.startsWith(`assets/${basename(entry, ".ts")}-`))

const workerProblems = Effect.fn("workerProblems")(function*(page: ReadonlyArray<Rollup.RollupOutput>, worker: Shipped & { readonly entry: string }) {
  const outputs = yield* buildEntry(worker.entry)
  const missingFile = emitsWorkerFile(page, worker.entry) ? [] : ["emits no worker file"]
  return [...missingFile, ...mismatches(keptNames(outputs), worker).map((problem) => `worker ${problem}`)]
})

const checkDeployment = Effect.fn("checkDeployment")(function*(expected: (typeof expectations)[number]) {
  const outputs = yield* buildDeployment(expected.deployment, { write: false })
  const pageProblems = mismatches(keptNames(outputs), expected)
  const inWorker = expected.worker === undefined ? [] : yield* workerProblems(outputs, expected.worker)
  const problems = [...pageProblems, ...inWorker]
  if (problems.length > 0) return yield* new BundleCheckFailure({ deployment: expected.deployment, message: `${expected.deployment}: ${problems.join(", ")}` })
  yield* Console.log(`ok ${expected.deployment}`)
})

const root = new URL("..", import.meta.url).pathname

/** A half built outside `auctionLocal.ts` reaches no export that the bundles are checked for, so it is looked for in the source. */
const checkLocalHalvesSource = Effect.fn("checkLocalHalvesSource")(function*() {
  const misplaced = misplacedLocalHalves(clientSources(root))
  if (misplaced.length === 0) return yield* Console.log("ok sources")
  const where = misplaced.map(({ path, line, call }) => `${path}:${line} ${call}`).join(", ")
  return yield* new BundleCheckFailure({
    deployment: "sources",
    message: `the auction's local halves are built only in src/client/placements/auctionLocal.ts: ${where}`
  })
})

/**
 * A page that runs only the local loop must not carry the synchronisation code, which `@mufw/core/sync`
 * keeps out of the `@mufw/core` entry: that code is what pulls `effect/eventlog` and `effect/encoding`
 * (`SchemaBinary`) in. `Schema` itself imports `effect/encoding/Base64`, so what the plain `Schema` floor
 * carries from those two directories is allowed; any other module of them in the page is a leak.
 * A module the bundler reports with no rendered code was tree-shaken away and is not carried.
 */
const SYNC_DIRECTORIES = ["/effect/dist/encoding/", "/effect/dist/eventlog/"]
const LOCAL_LOOP_PAGE = "scripts/bench/pages/counter-mufw.ts"
const SCHEMA_FLOOR = "scripts/bench/floors/effect-schema.ts"
/** The module of `@mufw/core` that builds the local loop: the control that the page is the one this check means. */
const LOCAL_LOOP_MODULE = "/packages/core/src/Layers.ts"

const carriedModules = (outputs: ReadonlyArray<Rollup.RollupOutput>) =>
  outputs
    .flatMap((bundle) => bundle.output)
    .flatMap((file) => file.type === "chunk" ? Object.entries(file.modules) : [])
    .filter(([, module]) => module.renderedLength > 0)
    .map(([id]) => id)

const isSyncModule = (id: string) => SYNC_DIRECTORIES.some((directory) => id.includes(directory))

const effectModuleName = (id: string) => id.slice(id.indexOf("/effect/dist/") + 1)

const localLoopProblems = (page: ReadonlyArray<string>, schemaFloor: ReadonlyArray<string>) => {
  const allowed = new Set(schemaFloor.filter(isSyncModule))
  const leaked = page.filter((id) => isSyncModule(id) && !allowed.has(id))
  const staleFloor = allowed.size === 0 ? [`${SCHEMA_FLOOR} carries no module of ${SYNC_DIRECTORIES.join(" or ")}`] : []
  const staleEntry = page.some((id) => id.endsWith(LOCAL_LOOP_MODULE)) ? [] : [`${LOCAL_LOOP_PAGE} carries no ${LOCAL_LOOP_MODULE}`]
  return [...staleFloor, ...staleEntry, ...leaked.map((id) => `carries ${effectModuleName(id)}`)]
}

const checkLocalLoopPage = Effect.fn("checkLocalLoopPage")(function*() {
  const page = carriedModules(yield* buildEntry(LOCAL_LOOP_PAGE))
  const schemaFloor = carriedModules(yield* buildEntry(SCHEMA_FLOOR))
  const problems = localLoopProblems(page, schemaFloor)
  if (problems.length > 0) return yield* new BundleCheckFailure({ deployment: "local-loop", message: `local-loop: ${problems.join(", ")}` })
  yield* Console.log("ok local-loop")
})

NodeRuntime.runMain(
  checkLocalHalvesSource().pipe(
    Effect.andThen(checkLocalLoopPage()),
    Effect.andThen(Effect.forEach(expectations, checkDeployment, { discard: true }))
  )
)
