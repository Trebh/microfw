import { NodeRuntime, NodeSocket } from "@effect/platform-node"
import { Config, Console, Effect, Layer, Schedule, Schema } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { type ChildProcess, spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { type Browser, chromium, type Page } from "playwright"
import { build, preview, type Rollup } from "vite"
import { layerAuthenticationAnonymous } from "../src/authentication.ts"
import { Auction, type Proposal } from "../src/domain/Auction.ts"
import { Amount, Bidder } from "../src/domain/Values.ts"
import { Ports, Rpc } from "../src/ports.ts"
import { samPath, samStreamPath } from "../src/samPath.ts"

/**
 * Compares the three ways a read-only island can follow the server's auction, each in headless
 * Chromium against a server this script starts: the ticker over the websocket, the ticker over HTTP
 * (NDJSON), and the HTML stream (no client bundle). Both measures are taken in the page and mean the
 * same for all three:
 *
 * - first paint: from the navigation's start to the first time the page's DOM shows the auction;
 * - update latency: from the moment this process sends `ModelPort.present` over its own websocket to
 *   the first time the page's DOM shows that update.
 *
 * The page is on the same machine and the server is local, so the network contributes nothing: the
 * numbers compare what each transport and renderer adds, not a real link.
 */

const AUCTION_ROOT = fileURLToPath(new URL("..", import.meta.url))

/** Ports are taken from here, so a dev server on :3001 or :5173 is left alone. */
const FIRST_PORT = 4700
const LAST_PORT = 4799

const CLOCK_SAMPLES = 200

/** A page that does not show an expected marker within this time makes the run fail. */
const MARKER_TIMEOUT_MS = 10_000

const Settings = Config.all({
  updates: Config.Int("MUFW_COMPARE_UPDATES").pipe(Config.withDefault(100)),
  warmupUpdates: Config.Int("MUFW_COMPARE_WARMUP").pipe(Config.withDefault(10)),
  loads: Config.Int("MUFW_COMPARE_LOADS").pipe(Config.withDefault(20))
})
type Settings = Config.Success<typeof Settings>

class CompareFailure extends Schema.TaggedError<CompareFailure>()("CompareFailure", {
  message: Schema.String
}) {}

const failWith = (message: string) => (error: unknown) =>
  new CompareFailure({ message: `${message}: ${String(error)}` })

// ---------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------

/**
 * Epoch milliseconds with sub-millisecond resolution. The page runs in another process, so both
 * sides read the wall clock (`timeOrigin` + monotonic `now`) and the offset between them is
 * calibrated; `Clock` has no such epoch reading.
 */
const epochMs = () => performance.timeOrigin + performance.now()

const percentile = (sorted: ReadonlyArray<number>, fraction: number) => {
  const rank = Math.ceil(fraction * sorted.length)
  return sorted[Math.max(0, rank - 1)] ?? Number.NaN
}

interface Summary {
  readonly median: number
  readonly p95: number
}

const summarize = (samples: ReadonlyArray<number>): Summary => {
  const sorted = [...samples].sort((a, b) => a - b)
  return { median: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) }
}

// ---------------------------------------------------------------------------------------------
// What the page reports
// ---------------------------------------------------------------------------------------------

const MARKERS_KEY = "__mufwMarkers"

/**
 * Runs in the page before any of its scripts, so a document that streams in is observed from its
 * first node. It is source text, not a function: the runner that executes this script (tsx) adds a
 * helper to every named function it compiles, and a serialized function would lack it in the page.
 */
const WATCH_MARKERS = `(() => {
  const seen = new Map()
  const scan = () => {
    const text = document.body ? document.body.textContent : ""
    for (const match of text.matchAll(/x(\\d+)x/g)) {
      const index = Number(match[1])
      if (!seen.has(index)) seen.set(index, performance.timeOrigin + performance.now())
    }
  }
  window.${MARKERS_KEY} = { origin: performance.timeOrigin, seen }
  new MutationObserver(scan).observe(document, { childList: true, subtree: true, characterData: true })
})()`

interface Sighting {
  readonly origin: number
  readonly at: number
}

/** When the page first showed update `index`, polled every millisecond so the wait adds nothing to the page's own stamp. */
const sightingOf = (page: Page, index: number): Promise<Sighting> =>
  page.waitForFunction(([key, wanted]) => {
    const markers = Reflect.get(window, key)
    const at = markers?.seen.get(wanted)
    return at === undefined ? null : { origin: markers.origin, at }
  }, [MARKERS_KEY, index] as const, { polling: 1, timeout: MARKER_TIMEOUT_MS }).then(async (handle) => {
    const sighting = await handle.jsonValue()
    if (sighting === null) throw new Error(`update ${index} resolved with no sighting`)
    return sighting
  })

/**
 * Offset of the browser's clock from this process's, from the round trip with the least delay. It is
 * taken once per run, so the error left in it (half the round trip's asymmetry) is the same for
 * every transport.
 */
const clockOffset = async (page: Page) => {
  const samples: Array<{ readonly rtt: number; readonly offset: number }> = []
  for (let i = 0; i < CLOCK_SAMPLES; i++) {
    const before = epochMs()
    const pageNow = await page.evaluate(() => performance.timeOrigin + performance.now())
    const after = epochMs()
    samples.push({ rtt: after - before, offset: pageNow - (before + after) / 2 })
  }
  return samples.reduce((best, sample) => sample.rtt < best.rtt ? sample : best).offset
}

// ---------------------------------------------------------------------------------------------
// Processes and files
// ---------------------------------------------------------------------------------------------

const isFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once("error", () => resolve(false))
    probe.listen(port, () => probe.close(() => resolve(true)))
  })

const freePort = Effect.fn("freePort")(function*(from: number) {
  for (let port = from; port <= LAST_PORT; port++) {
    if (yield* Effect.promise(() => isFree(port))) return port
  }
  return yield* new CompareFailure({ message: `no free port in ${FIRST_PORT}-${LAST_PORT}` })
})

/** The server's settings come from here alone: a `MUFW_*` variable of the caller must not change what is measured. */
const serverEnv = (port: number) => {
  const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith("MUFW_"))
  return {
    ...Object.fromEntries(inherited),
    MUFW_PORT: String(port),
    MUFW_AUTO_ACTIONS: "off",
    MUFW_RPCS: "Present,Representations"
  }
}

const PROCESS_STOP_GRACE_MS = 3_000

/** SIGTERM, then SIGKILL if the process has not left after the grace period. */
const stopProcess = (child: ChildProcess) =>
  Effect.promise(() =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      const force = setTimeout(() => child.kill("SIGKILL"), PROCESS_STOP_GRACE_MS)
      child.once("exit", () => {
        clearTimeout(force)
        resolve()
      })
      child.kill("SIGTERM")
    })
  )

const accepts = (port: number) =>
  new Promise<void>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    socket.once("connect", () => socket.end(resolve))
    socket.once("error", reject)
  })

const untilListening = (port: number) =>
  Effect.tryPromise({ try: () => accepts(port), catch: failWith(`nothing listens on ${port}`) }).pipe(
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 200 })
  )

/** A server with the auction fresh and no automatic actions, serving `Present` and `Representations`; stopped with the scope. */
const startServer = (port: number) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
        cwd: AUCTION_ROOT,
        env: serverEnv(port),
        stdio: ["ignore", "ignore", "inherit"]
      })
    ),
    stopProcess
  ).pipe(Effect.tap(() => untilListening(port)))

// ---------------------------------------------------------------------------------------------
// The two pages with a client bundle
// ---------------------------------------------------------------------------------------------

type BundledTransport = "websocket" | "http"

/** The placement module each bundled page composes, so a page's bundle holds that transport only. */
const placementOf: Record<BundledTransport, { readonly module: string; readonly name: string }> = {
  websocket: { module: "socketReadOnly", name: "socketReadOnly" },
  http: { module: "httpReadOnly", name: "httpReadOnly" }
}

const clientModule = (relative: string) => join(AUCTION_ROOT, "src", "client", relative)

const harnessPage = (transport: BundledTransport) => {
  const placement = placementOf[transport]
  return [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>ticker</title></head><body>",
    "<div id=\"ticker\"></div>",
    "<script type=\"module\">",
    `import { runTicker } from ${JSON.stringify(clientModule("ticker.ts"))}`,
    `import { ${placement.name} } from ${JSON.stringify(clientModule(`placements/${placement.module}.ts`))}`,
    `runTicker(document.getElementById("ticker"), { placement: ${placement.name}, source: ${JSON.stringify(transport)} })`,
    "</script></body></html>"
  ].join("\n")
}

interface Bundle {
  readonly rawBytes: number
  readonly gzipBytes: number
}

const chunksOf = (result: unknown): ReadonlyArray<Rollup.OutputChunk> => {
  const outputs: ReadonlyArray<unknown> = Array.isArray(result) ? result : [result]
  return outputs.flatMap((output) =>
    typeof output === "object" && output !== null && "output" in output && Array.isArray(output.output)
      ? output.output.filter((file): file is Rollup.OutputChunk => file.type === "chunk")
      : []
  )
}

const bundleOf = (chunks: ReadonlyArray<Rollup.OutputChunk>): Bundle => {
  const code = chunks.map((chunk) => chunk.code).join("\n")
  return { rawBytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).byteLength }
}

/** `vite build` of one harness page into `outDir`, with the server's origin as this build's `VITE_SERVER_URL`. */
const buildPage = (directory: string, outDir: string, transport: BundledTransport) =>
  Effect.tryPromise({
    try: async () => {
      const page = join(directory, `${transport}.html`)
      await writeFile(page, harnessPage(transport))
      const result = await build({
        root: directory,
        configFile: false,
        logLevel: "silent",
        build: { outDir, emptyOutDir: false, rollupOptions: { input: page } }
      })
      return bundleOf(chunksOf(result))
    },
    catch: failWith(`building the ${transport} page`)
  })

interface Pages {
  readonly origin: string
  readonly bundles: Record<BundledTransport, Bundle>
}

/**
 * Builds both pages (production bundles, minified, as `pnpm build:client` does) into a temporary
 * directory and serves them on `port`; the directory is removed with the scope.
 */
const servePages = Effect.fn("servePages")(function*(port: number, serverPort: number) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "mufw-compare-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
  )
  const outDir = join(directory, "dist")
  yield* Effect.promise(() => mkdir(outDir))
  yield* Effect.promise(() => writeFile(join(directory, ".env"), `VITE_SERVER_URL=ws://127.0.0.1:${serverPort}\n`))
  const websocket = yield* buildPage(directory, outDir, "websocket")
  const http = yield* buildPage(directory, outDir, "http")
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        preview({
          root: directory,
          configFile: false,
          logLevel: "silent",
          build: { outDir },
          preview: { port, strictPort: true, host: "127.0.0.1" }
        }),
      catch: failWith("serving the pages")
    }),
    (server) => Effect.promise(() => server.close())
  )
  return { origin: `http://127.0.0.1:${port}`, bundles: { websocket, http } } satisfies Pages
})

// ---------------------------------------------------------------------------------------------
// The measured cases
// ---------------------------------------------------------------------------------------------

/** What every case shares: the browser, the built pages, the server's port, the settings and the clock offset. */
interface Run {
  readonly browser: Browser
  readonly pages: Pages
  readonly serverPort: number
  readonly settings: Settings
  readonly offset: number
}

interface Case {
  readonly name: string
  readonly url: (pages: Pages, serverOrigin: string) => string
  readonly bundle: (pages: Pages) => Bundle | undefined
}

const cases: ReadonlyArray<Case> = [
  {
    name: "socket (websocket, JSON)",
    url: (pages) => `${pages.origin}/websocket.html`,
    bundle: (pages) => pages.bundles.websocket
  },
  {
    name: "HTTP (NDJSON, fetch)",
    url: (pages) => `${pages.origin}/http.html`,
    bundle: (pages) => pages.bundles.http
  },
  {
    name: "HTML stream (no bundle)",
    url: (_pages, serverOrigin) => `${serverOrigin}${samStreamPath(Auction)}`,
    bundle: () => undefined
  }
]

const opened: Proposal = { _tag: "Opened", at: 1_000 }

/**
 * Update `index` is a bid that is always valid (the minimum increment is 5), by a bidder named
 * `x<index>x`: the first time the page's text holds that name is the first time it shows the update.
 * Update 0 is the auction as it is when the page loads.
 */
const bidNumber = (index: number): Proposal => ({
  _tag: "Bid",
  bidder: Bidder.make(`x${index}x`),
  amount: Amount.make(5 * (index + 1)),
  at: 1_000 + index
})

/** This process's own `ModelPort`, over a websocket: the server's `Present` is how the model is moved. */
const layerPresenter = (port: number) =>
  Rpc.layerModelRemote.pipe(
    Layer.provide(
      Rpc.layerClient.pipe(
        Layer.provide(layerAuthenticationAnonymous),
        Layer.provide(RpcClient.layerProtocolSocket()),
        Layer.provide(NodeSocket.layerWebSocket(`ws://127.0.0.1:${port}${samPath(Auction)}`)),
        Layer.provide(RpcSerialization.layerJson)
      )
    )
  )

const openPage = (browser: Browser) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const context = await browser.newContext()
      const page = await context.newPage()
      page.on("pageerror", (error) => console.error(`page error: ${error.message}`))
      await page.addInitScript({ content: WATCH_MARKERS })
      return { context, page }
    }),
    ({ context }) => Effect.promise(() => context.close())
  )

/** One cold load in a context of its own: the time from the navigation's start to the page showing update 0. */
const firstPaintOnce = (browser: Browser, url: string) =>
  Effect.gen(function*() {
    const { page } = yield* openPage(browser)
    yield* Effect.tryPromise({ try: () => page.goto(url, { waitUntil: "commit" }), catch: failWith(`loading ${url}`) })
    const sighting = yield* Effect.tryPromise({ try: () => sightingOf(page, 0), catch: failWith(`first paint of ${url}`) })
    return sighting.at - sighting.origin
  }).pipe(Effect.scoped)

/** One discarded load warms the browser process and the server's route; the next `loads` are the sample. */
const firstPaints = Effect.fn("firstPaints")(function*(browser: Browser, url: string, loads: number) {
  yield* firstPaintOnce(browser, url)
  return yield* Effect.forEach(Array.from({ length: loads }, (_, i) => i), () => firstPaintOnce(browser, url))
})

/** Updates `1..count` sent one at a time, each after the page has shown the one before. */
const updateLatencies = Effect.fn("updateLatencies")(function*(run: Run, url: string) {
  const { browser, offset, settings } = run
  const model = yield* Ports.ModelPort
  const { page } = yield* openPage(browser)
  yield* Effect.tryPromise({ try: () => page.goto(url, { waitUntil: "commit" }), catch: failWith(`loading ${url}`) })
  yield* Effect.tryPromise({ try: () => sightingOf(page, 0), catch: failWith(`first paint of ${url}`) })
  const indexes = Array.from({ length: settings.warmupUpdates + settings.updates }, (_, i) => i + 1)
  const latencies = yield* Effect.forEach(indexes, (index) =>
    Effect.gen(function*() {
      const sentAt = epochMs()
      yield* model.present(bidNumber(index))
      const sighting = yield* Effect.tryPromise({
        try: () => sightingOf(page, index),
        catch: failWith(`update ${index} of ${url}`)
      })
      return sighting.at - offset - sentAt
    }))
  return latencies.slice(settings.warmupUpdates)
})

interface Measured {
  readonly name: string
  readonly firstPaint: Summary
  readonly update: Summary
  readonly bundle: Bundle | undefined
}

/** A fresh server per case, so every transport meets the same auction: open, one bid. */
const measureCase = Effect.fn("measureCase")(function*(run: Run, measured: Case) {
  yield* startServer(run.serverPort)
  const url = measured.url(run.pages, `http://127.0.0.1:${run.serverPort}`)
  const seeded = Effect.gen(function*() {
    const model = yield* Ports.ModelPort
    yield* model.present(opened)
    yield* model.present(bidNumber(0))
    const loads = yield* firstPaints(run.browser, url, run.settings.loads)
    const updates = yield* updateLatencies(run, url)
    return { loads, updates }
  })
  const { loads, updates } = yield* seeded.pipe(Effect.provide(layerPresenter(run.serverPort)))
  return {
    name: measured.name,
    firstPaint: summarize(loads),
    update: summarize(updates),
    bundle: measured.bundle(run.pages)
  } satisfies Measured
}, Effect.scoped)

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const ms = (value: number) => value.toFixed(1)
const kib = (bytes: number) => (bytes / 1024).toFixed(1)

const columns = (measured: Measured) => [
  measured.name,
  `${ms(measured.firstPaint.median)} / ${ms(measured.firstPaint.p95)}`,
  `${ms(measured.update.median)} / ${ms(measured.update.p95)}`,
  measured.bundle === undefined ? "0" : `${kib(measured.bundle.rawBytes)} / ${kib(measured.bundle.gzipBytes)}`
]

const HEADER = ["transport", "first paint ms (median / p95)", "update ms (median / p95)", "client JS KiB (raw / gzip)"]

const table = (rows: ReadonlyArray<ReadonlyArray<string>>) => {
  const widths = HEADER.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0)))
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd()).join("\n")
}

const program = Effect.gen(function*() {
  const settings = yield* Settings
  const serverPort = yield* freePort(FIRST_PORT)
  const pagesPort = yield* freePort(serverPort + 1)
  const pages = yield* servePages(pagesPort, serverPort)
  const browser = yield* Effect.acquireRelease(
    Effect.tryPromise({ try: () => chromium.launch({ headless: true }), catch: failWith("launching Chromium") }),
    (launched) => Effect.promise(() => launched.close())
  )
  const offset = yield* openPage(browser).pipe(
    Effect.flatMap(({ page }) => Effect.promise(() => clockOffset(page))),
    Effect.scoped
  )
  const run: Run = { browser, pages, serverPort, settings, offset }
  const results = yield* Effect.forEach(cases, (measured) => measureCase(run, measured))
  yield* Console.log(
    `${settings.loads} cold loads and ${settings.updates} updates per transport (after ${settings.warmupUpdates} warm-up updates)`
  )
  yield* Console.log(table([HEADER, ...results.map(columns)]))
}).pipe(Effect.scoped)

NodeRuntime.runMain(program)
