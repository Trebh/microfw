import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { cpus, totalmem } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"
import { build, type Rollup } from "vite"
import { benchPages } from "./bench/pages.ts"
import { buildDeployment, buildEntry, BuildFailure } from "./build.ts"
import { pages } from "./pages.ts"
import { kib, table } from "./stats.ts"

/**
 * How much JavaScript a µFW page ships, next to what a hand-written page ships, and where the
 * bytes come from. Everything is built in memory (`write: false`) the way `vite build` builds a
 * production bundle (minified, tree-shaken), then measured:
 *
 * - the four floor entries under `scripts/bench/floors` (size only, never run): the Effect runtime,
 *   plus schemas, plus a service/layer/subscription-ref/pub-sub/stream, plus `@mufw/core`'s local
 *   loop; each one adds a layer of what a µFW page cannot do without;
 * - the four bench pages (`counter` and `list`, each as plain uhtml and over a µFW local loop);
 * - every deployment of `scripts/pages.ts`, built with `vite build --mode <deployment>`, and the
 *   JavaScript assets such a build emits for a web worker, as rows of their own.
 *
 * Table 1 is the size of each entry: the minified JavaScript the browser downloads, raw, gzip at
 * level 9 and brotli at quality 11, summed over its chunks (each chunk is compressed on its own,
 * as a server would send it). Table 2 attributes the minified bytes to where the code came from.
 * Table 3 lists the biggest modules of three entries. The last table subtracts the plain page from
 * the µFW page (the framework's fixed cost) and the µFW page from the full example (what an
 * application adds).
 *
 * Not measured: CSS, HTML, the embedded snapshot, parse and execution time (see the other `bench:`
 * scripts), and a server's compression settings. Known biases:
 *
 * - Attribution is an approximation. Rolldown reports, per chunk, each module's `renderedLength`:
 *   its code after tree-shaking and before minification. Table 2 scales the modules of a chunk by
 *   the same factor so that they add up to the chunk's minified length; minification does not
 *   shrink every module alike, and code that the minifier inlines or merges across modules is
 *   charged to the module that rendered it. Glue that no module renders is charged to `other`.
 * - A page's worker is an opaque asset of the page build with no module list. Its size is that of
 *   the asset; its attribution is that of a second, in-memory build of `src/client/auctionWorker.ts`
 *   (`buildEntry`, not minified), scaled to the asset's size.
 * - gzip level 9 and brotli quality 11 are best-case compression; a server that compresses on the
 *   fly usually sends more.
 * - The floors and bench pages are built with `configFile: false`, so they do not share
 *   `vite.config.ts` (no worker format, no `.env.<mode>` files). The deployments are built exactly
 *   as `pnpm build:client` builds them.
 * - `effect` is attributed by the first segment under `effect/dist` (`internal` and `unstable` by
 *   the second): `internal/core` is the runtime the public modules sit on, not a module an
 *   application imports.
 */

const AUCTION_ROOT = fileURLToPath(new URL("..", import.meta.url))

const WORKER_ENTRY = "src/client/auctionWorker.ts"

const FLOORS = ["effect-runtime", "effect-schema", "effect-stream-layer", "mufw-core"]

/** Entries whose biggest modules are listed. */
const TOP_MODULES_OF = ["counter-mufw", "list-mufw", "browser-only"]
const TOP_MODULE_COUNT = 20
const EFFECT_GROUP_COUNT = 12

type Kind = "floor" | "bench page" | "deployment" | "worker JS"

/** A module's code in an entry: as rendered by the bundler, and scaled to the minified bytes shipped. */
interface ModuleShare {
  readonly id: string
  readonly rendered: number
  readonly shipped: number
}

/** What a browser fetches for one entry (`files`) and where those bytes came from (`shares`). */
interface Entry {
  readonly name: string
  readonly kind: Kind
  readonly files: ReadonlyArray<Uint8Array>
  readonly shares: ReadonlyArray<ModuleShare>
}

interface Sizes {
  readonly raw: number
  readonly gzip: number
  readonly brotli: number
  readonly chunks: number
}

interface Measured {
  readonly entry: Entry
  readonly sizes: Sizes
}

// ---------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------

const isRollupOutput = (output: unknown): output is Rollup.RollupOutput =>
  typeof output === "object" && output !== null && "output" in output

/** What `vite build` returns when it built, as opposed to a watcher. */
const toRollupOutputs = (name: string, result: unknown) => {
  const outputs: ReadonlyArray<unknown> = Array.isArray(result) ? result : [result]
  const rollupOutputs = outputs.filter(isRollupOutput)
  return rollupOutputs.length === outputs.length
    ? Effect.succeed(rollupOutputs)
    : Effect.fail(new BuildFailure({ deployment: name, message: "vite returned a watcher, not a build" }))
}

/** Builds `input` (an html page or a script) in memory with vite's production defaults and no config file. */
const buildInput = (name: string, input: string) =>
  Effect.tryPromise({
    try: () =>
      build({ root: AUCTION_ROOT, configFile: false, logLevel: "silent", build: { write: false, rollupOptions: { input } } }),
    catch: (error) => new BuildFailure({ deployment: name, message: String(error) })
  }).pipe(Effect.flatMap((result) => toRollupOutputs(name, result)))

const chunksOf = (outputs: ReadonlyArray<Rollup.RollupOutput>) =>
  outputs.flatMap((bundle) => bundle.output).filter((file): file is Rollup.OutputChunk => file.type === "chunk")

/** A page build emits only a worker's files as JavaScript assets. */
const jsAssetsOf = (outputs: ReadonlyArray<Rollup.RollupOutput>) =>
  outputs
    .flatMap((bundle) => bundle.output)
    .filter((file): file is Rollup.OutputAsset => file.type === "asset" && file.fileName.endsWith(".js"))

const toBytes = (source: string | Uint8Array) => typeof source === "string" ? Buffer.from(source) : source

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0)

/** Rendered length of every module of `chunks`, by module id. */
const renderedOf = (chunks: ReadonlyArray<Rollup.OutputChunk>) => {
  const rendered = new Map<string, number>()
  for (const chunk of chunks) {
    for (const [id, module] of Object.entries(chunk.modules)) {
      rendered.set(id, (rendered.get(id) ?? 0) + module.renderedLength)
    }
  }
  return rendered
}

const UNATTRIBUTED = "\0unattributed"

/** The modules in `rendered`, scaled so that they add up to `shippedBytes`. */
const sharesOf = (rendered: ReadonlyMap<string, number>, shippedBytes: number): ReadonlyArray<ModuleShare> => {
  const total = sum([...rendered.values()])
  if (total === 0) return [{ id: UNATTRIBUTED, rendered: 0, shipped: shippedBytes }]
  const scale = shippedBytes / total
  return [...rendered].map(([id, length]) => ({ id, rendered: length, shipped: length * scale }))
}

const chunkShares = (chunk: Rollup.OutputChunk) => sharesOf(renderedOf([chunk]), Buffer.byteLength(chunk.code))

const chunkEntry = (name: string, kind: Kind, outputs: ReadonlyArray<Rollup.RollupOutput>): Entry => {
  const chunks = chunksOf(outputs)
  return { name, kind, files: chunks.map((chunk) => Buffer.from(chunk.code)), shares: chunks.flatMap(chunkShares) }
}

/** The worker files of a page build, as one entry attributed from the module list of the worker's own build. */
const workerEntries = (
  name: string,
  outputs: ReadonlyArray<Rollup.RollupOutput>,
  workerRendered: ReadonlyMap<string, number>
): ReadonlyArray<Entry> => {
  const files = jsAssetsOf(outputs).map((asset) => toBytes(asset.source))
  if (files.length === 0) return []
  const shares = sharesOf(workerRendered, sum(files.map((file) => file.byteLength)))
  return [{ name: `${name}: worker JS`, kind: "worker JS", files, shares } satisfies Entry]
}

const floorEntry = Effect.fn("floorEntry")(function*(name: string) {
  const outputs = yield* buildInput(name, join(AUCTION_ROOT, "scripts", "bench", "floors", `${name}.ts`))
  return chunkEntry(name, "floor", outputs)
})

const benchPageEntry = Effect.fn("benchPageEntry")(function*(name: string, html: string) {
  const outputs = yield* buildInput(name, join(AUCTION_ROOT, html))
  return chunkEntry(name, "bench page", outputs)
})

const deploymentEntries = Effect.fn("deploymentEntries")(function*(
  name: string,
  workerRendered: ReadonlyMap<string, number>
) {
  const outputs = yield* buildDeployment(name, { write: false })
  return [chunkEntry(name, "deployment", outputs), ...workerEntries(name, outputs, workerRendered)]
})

/** The worker's own module graph, built once: a page build reports none for the worker it emits. */
const workerRenderedModules = Effect.gen(function*() {
  const outputs = yield* buildEntry(WORKER_ENTRY)
  return renderedOf(chunksOf(outputs))
})

// ---------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------

const gzipLength = (bytes: Uint8Array) => gzipSync(bytes, { level: 9 }).byteLength

const brotliLength = (bytes: Uint8Array) =>
  brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength
    }
  }).byteLength

const sizesOf = (entry: Entry): Sizes => ({
  raw: sum(entry.files.map((file) => file.byteLength)),
  gzip: sum(entry.files.map(gzipLength)),
  brotli: sum(entry.files.map(brotliLength)),
  chunks: entry.files.length
})

const measure = (entry: Entry): Measured => ({ entry, sizes: sizesOf(entry) })

// ---------------------------------------------------------------------------------------------
// Where a module came from
// ---------------------------------------------------------------------------------------------

interface Origin {
  readonly pkg: string
  readonly tail: string
}

const EXAMPLE_APP = "example app"
const STATELY = "@statelyai/inspect + xstate"
const OTHER = "other"
const OTHER_EFFECT = "other effect"
const EFFECT_PREFIX = "effect/"

/** Workspace packages resolve to their real path, which has no `node_modules` segment. */
const WORKSPACE_PACKAGES: ReadonlyArray<readonly [string, string]> = [
  ["/packages/core/", "@mufw/core"],
  ["/packages/rpc/", "@mufw/rpc"],
  ["/packages/view-uhtml/", "@mufw/view-uhtml"],
  ["/packages/devtools/", "@mufw/devtools"],
  ["/examples/auction/", EXAMPLE_APP]
]

/** What uhtml itself depends on, charged to uhtml. */
const UHTML_PACKAGES: Readonly<Record<string, true>> = {
  "uhtml": true,
  "@webreflection/uparser": true,
  "custom-function": true,
  "domconstants": true,
  "gc-hook": true,
  "html-escaper": true,
  "htmlparser2": true,
  "udomdiff": true,
  "domhandler": true,
  "domutils": true,
  "dom-serializer": true,
  "domelementtype": true,
  "entities": true
}

/** What the Stately inspector depends on, charged to it. */
const STATELY_PACKAGES: Readonly<Record<string, true>> = {
  "@statelyai/inspect": true,
  "xstate": true,
  "fast-safe-stringify": true,
  "isomorphic-ws": true,
  "partysocket": true,
  "event-target-polyfill": true,
  "safe-stable-stringify": true,
  "superjson": true,
  "copy-anything": true,
  "is-what": true,
  "ws": true
}

/** Rows of table 2 after the `effect` ones, in this order. */
const FIXED_GROUPS = [
  "@effect/platform-browser",
  "@mufw/core",
  "@mufw/rpc",
  "@mufw/view-uhtml",
  "@mufw/devtools",
  "uhtml",
  STATELY,
  EXAMPLE_APP,
  OTHER
]

/** `node_modules/<pkg>/<tail>` with `pkg` being one segment, or two when scoped. */
const splitPackagePath = (path: string): Origin => {
  const segments = path.split("/")
  const nameLength = segments[0]?.startsWith("@") ? 2 : 1
  return { pkg: segments.slice(0, nameLength).join("/"), tail: segments.slice(nameLength).join("/") }
}

const workspaceOrigin = (id: string): Origin => {
  const found = WORKSPACE_PACKAGES.find(([prefix]) => id.includes(prefix))
  if (found === undefined) return { pkg: OTHER, tail: id }
  const [prefix, pkg] = found
  return { pkg, tail: id.slice(id.indexOf(prefix) + prefix.length) }
}

/** The package a module id belongs to and the path inside it; ids go through `node_modules/.pnpm/...`. */
const originOf = (rawId: string): Origin => {
  const id = rawId.split("?")[0] ?? rawId
  const marker = "/node_modules/"
  const at = id.lastIndexOf(marker)
  return at >= 0 ? splitPackagePath(id.slice(at + marker.length)) : workspaceOrigin(id)
}

const withoutExtension = (segment: string) => segment.replace(/\.[cm]?[jt]s$/, "")

/** `Schema`, `Stream`, ...: the module of `effect` a file belongs to; `internal/<x>` and `unstable/<x>` keep their second segment. */
const effectSubgroup = (tail: string) => {
  const [first = "", second] = tail.replace(/^dist\//, "").split("/")
  if ((first === "internal" || first === "unstable") && second !== undefined) {
    return `${EFFECT_PREFIX}${first}/${withoutExtension(second)}`
  }
  return `${EFFECT_PREFIX}${withoutExtension(first)}`
}

const groupOf = (origin: Origin) => {
  if (origin.pkg === "effect") return effectSubgroup(origin.tail)
  if (Object.hasOwn(UHTML_PACKAGES, origin.pkg)) return "uhtml"
  if (Object.hasOwn(STATELY_PACKAGES, origin.pkg)) return STATELY
  return FIXED_GROUPS.includes(origin.pkg) ? origin.pkg : OTHER
}

/** Minified bytes of an entry by group. */
const groupBytes = (entry: Entry) => {
  const bytes = new Map<string, number>()
  for (const share of entry.shares) {
    const group = groupOf(originOf(share.id))
    bytes.set(group, (bytes.get(group) ?? 0) + share.shipped)
  }
  return bytes
}

/** The `effect` groups that weigh most over all `entries`: the rows that keep their own line. */
const heaviestEffectGroups = (perEntry: ReadonlyArray<ReadonlyMap<string, number>>) => {
  const totals = new Map<string, number>()
  for (const bytes of perEntry) {
    for (const [group, size] of bytes) {
      if (group.startsWith(EFFECT_PREFIX)) totals.set(group, (totals.get(group) ?? 0) + size)
    }
  }
  return [...totals].sort((a, b) => b[1] - a[1]).slice(0, EFFECT_GROUP_COUNT).map(([group]) => group)
}

/** The lighter `effect` groups folded into one. */
const foldEffectGroups = (bytes: ReadonlyMap<string, number>, kept: ReadonlyArray<string>) => {
  const folded = new Map<string, number>()
  for (const [group, size] of bytes) {
    const row = group.startsWith(EFFECT_PREFIX) && !kept.includes(group) ? OTHER_EFFECT : group
    folded.set(row, (folded.get(row) ?? 0) + size)
  }
  return folded
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const environmentLine = () => {
  const [cpu] = cpus()
  const memory = (totalmem() / 2 ** 30).toFixed(1)
  return `node ${process.version} · ${cpu?.model ?? "unknown cpu"} · ${cpus().length} CPUs · ${memory} GiB memory`
}

const section = (heading: string, rows: ReadonlyArray<ReadonlyArray<string>>) =>
  Console.log(`\n${heading}\n\n${table(rows)}`)

const sizeRow = ({ entry, sizes }: Measured) => [
  entry.name,
  entry.kind,
  kib(sizes.raw),
  kib(sizes.gzip),
  kib(sizes.brotli),
  String(sizes.chunks)
]

const sizesTable = (measured: ReadonlyArray<Measured>) =>
  section("Table 1 - minified JavaScript each entry ships, KiB (gzip level 9, brotli quality 11), and its number of JS chunks", [
    ["entry", "kind", "JS raw", "gzip", "brotli", "chunks"],
    ...measured.map(sizeRow)
  ])

/** One table of group by entry, in minified KiB. */
const groupTable = (heading: string, entries: ReadonlyArray<Entry>) => {
  const perEntry = entries.map(groupBytes)
  const kept = heaviestEffectGroups(perEntry)
  const folded = perEntry.map((bytes) => foldEffectGroups(bytes, kept))
  const candidates = [...kept, OTHER_EFFECT, ...FIXED_GROUPS]
  const groups = candidates.filter((group) => folded.some((bytes) => (bytes.get(group) ?? 0) > 0))
  const totals = folded.map((bytes) => sum([...bytes.values()]))
  return section(heading, [
    ["origin", ...entries.map((entry) => entry.name)],
    ...groups.map((group) => [group, ...folded.map((bytes) => kib(bytes.get(group) ?? 0))]),
    ["total", ...totals.map(kib)]
  ])
}

const attributionTables = (entries: ReadonlyArray<Entry>) =>
  Effect.gen(function*() {
    const unit = "minified KiB per origin, approximate (rendered length scaled to the chunk's minified length)"
    yield* groupTable(`Table 2a - floors and bench pages: ${unit}`, entries.filter((entry) => entry.kind === "floor" || entry.kind === "bench page"))
    yield* groupTable(`Table 2b - deployments: ${unit}`, entries.filter((entry) => entry.kind === "deployment" || entry.kind === "worker JS"))
  })

const entryNamed = (entries: ReadonlyArray<Entry>, name: string): Effect.Effect<Entry, BuildFailure> => {
  const found = entries.find((entry) => entry.name === name)
  return found === undefined
    ? Effect.fail(new BuildFailure({ deployment: name, message: "no such entry was built" }))
    : Effect.succeed(found)
}

const topModulesTable = (entry: Entry) => {
  const total = sum(entry.shares.map((share) => share.rendered))
  const biggest = [...entry.shares].sort((a, b) => b.rendered - a.rendered).slice(0, TOP_MODULE_COUNT)
  const rows = biggest.map((share) => {
    const { pkg, tail } = originOf(share.id)
    return [pkg, tail, kib(share.rendered), `${((share.rendered / total) * 100).toFixed(1)}%`]
  })
  return section(`Table 3 - the ${TOP_MODULE_COUNT} biggest modules of ${entry.name}, by rendered length (KiB after tree-shaking, before minification)`, [
    ["package", "module", "rendered KiB", "share"],
    ...rows
  ])
}

const sizesOfNamed = (measured: ReadonlyArray<Measured>, name: string): Effect.Effect<Sizes, BuildFailure> => {
  const found = measured.find(({ entry }) => entry.name === name)
  return found === undefined
    ? Effect.fail(new BuildFailure({ deployment: name, message: "no such entry was built" }))
    : Effect.succeed(found.sizes)
}

const differenceRow = (label: string, bigger: Sizes, smaller: Sizes) => [
  label,
  kib(bigger.raw - smaller.raw),
  kib(bigger.gzip - smaller.gzip),
  kib(bigger.brotli - smaller.brotli),
  `${(bigger.gzip / smaller.gzip).toFixed(1)}x`
]

/** Fixed cost of the framework against the per-application cost, from three of the entries above. */
const derivedTable = (measured: ReadonlyArray<Measured>) =>
  Effect.gen(function*() {
    const plain = yield* sizesOfNamed(measured, "counter-uhtml")
    const counter = yield* sizesOfNamed(measured, "counter-mufw")
    const app = yield* sizesOfNamed(measured, "browser-only")
    yield* section("Derived - difference in KiB, and how many times larger the first term is than the second (gzip)", [
      ["what", "JS raw", "gzip", "brotli", "gzip ratio"],
      differenceRow("framework floor: counter-mufw - counter-uhtml", counter, plain),
      differenceRow("app increment: browser-only - counter-mufw", app, counter)
    ])
  })

const report = Effect.fn("report")(function*(entries: ReadonlyArray<Entry>) {
  const measured = entries.map(measure)
  yield* sizesTable(measured)
  yield* attributionTables(entries)
  yield* Effect.forEach(TOP_MODULES_OF, (name) => Effect.flatMap(entryNamed(entries, name), topModulesTable), {
    discard: true
  })
  yield* derivedTable(measured)
})

const program = Effect.gen(function*() {
  yield* Console.log(environmentLine())
  const workerRendered = yield* workerRenderedModules
  const floors = yield* Effect.forEach(FLOORS, floorEntry)
  const benchPageEntries = yield* Effect.forEach(Object.entries(benchPages), ([name, html]) => benchPageEntry(name, html))
  const deployments = yield* Effect.forEach(Object.keys(pages), (name) => deploymentEntries(name, workerRendered))
  yield* report([...floors, ...benchPageEntries, ...deployments.flat()])
})

NodeRuntime.runMain(program)
