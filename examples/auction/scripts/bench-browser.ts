import { NodeRuntime } from "@effect/platform-node"
import { Config, Console, Effect, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { cpus, tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from "playwright"
import { build, preview } from "vite"
import { LIST_ROWS } from "./bench/list.ts"
import { type BenchPage, benchPages } from "./bench/pages.ts"
import { pages } from "./pages.ts"
import { kib, ms, type Summary, summarize, table } from "./stats.ts"

/**
 * What a µFW page costs in a browser, next to a hand-written uhtml page that renders the same
 * markup, and next to the `browser-only` auction deployment as a realistic whole application. Each
 * page is built as a production bundle (minified, as `pnpm build:client` does), served by `vite
 * preview` and loaded in headless Chromium, once per CPU throttling rate (`Emulation.
 * setCPUThrottlingRate`: 1 is the machine's own speed, 4 approximates a mid-range phone's CPU).
 *
 * Per page and rate:
 *
 * - first content: from the navigation's start to the first time the DOM holds the expected content
 *   (counter: `#count`; list: 1000 `li`; auction: the view's `h1`), stamped in the page by a
 *   MutationObserver; each load is a fresh browser context (no HTTP cache) and the first is discarded;
 * - script, task, heap: CDP `Performance.getMetrics` after the content and one more frame, so they
 *   cover the whole load (`ScriptDuration` is time in V8 including parsing and compiling, `TaskDuration`
 *   all main-thread work); the heap is `JSHeapUsedSize` after a forced garbage collection;
 * - JS KiB: the bytes of every `.js` response as served (no compression: `vite preview` sends none);
 * - click to DOM: from the click event's own timestamp (so input delay is included) to the first
 *   mutation observer callback after which the DOM shows the update; click to next frame: from the same
 *   start to `requestAnimationFrame` then `setTimeout(0)` after that, the usual proxy for what INP
 *   measures. Both stamps are taken in the page; Playwright only delivers the click.
 *
 * Interactions: the counter's `+1`; a list row's toggle (a different row each time); a valid bid in
 * the auction's own form. The auction runs its one-second tick throughout, and its bid list grows by
 * one entry per bid, so its latency is that of an application, not comparable to the plain baselines.
 * It has no baseline, so it is not in the ratio table. A very large `BENCH_INTERACTIONS` can outlast
 * the auction's 60 seconds, after which its form is disabled and the run fails.
 *
 * Not measured, and the known biases: localhost, so no network latency, bandwidth or compression
 * (JS KiB is raw; see `bench:bundle` for gzip); headless Chromium on a machine that is also running
 * this script, so the numbers move with whatever else is running; CPU throttling slows the main
 * thread only, not the compositor, memory or storage of a phone; interactions run after warm-up on warm
 * JIT, so they say nothing about the first click; frames are not presented to a display; the pages'
 * own MutationObserver (the same in every page) adds a small constant to each reading. The bench
 * pages are built with no config file, the auction with the example's own `vite.config.ts`.
 */

const AUCTION_ROOT = fileURLToPath(new URL("..", import.meta.url))

/** Ports are taken from here, so a dev server on :3001 or :5173 and the other scripts' ranges are left alone. */
const FIRST_PORT = 4600
const LAST_PORT = 4699

/** One load, discarded, warms the browser process, the page server and the OS file cache. */
const DISCARDED_LOADS = 1

/** A page that shows no first content, or no update, within these times makes the run fail. */
const CONTENT_TIMEOUT_MS = 20_000
const UPDATE_TIMEOUT_MS = 20_000
const CLICK_TIMEOUT_MS = 10_000

/** A list row's step through the table: coprime with the row count, so consecutive toggles hit distinct, distant rows. */
const ROW_STRIDE = 37

const AUCTION_DEPLOYMENT = "browser-only"
const AUCTION_NAME = "auction (browser-only)"

const CpuRate = Schema.NumberFromString.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))

const Settings = Config.all({
  cpuRates: Config.Array(CpuRate, "BENCH_CPU_RATES").pipe(Config.withDefault([1, 4])),
  loads: Config.Int("BENCH_LOADS").pipe(Config.withDefault(15)),
  interactions: Config.Int("BENCH_INTERACTIONS").pipe(Config.withDefault(100)),
  warmupInteractions: Config.Int("BENCH_WARMUP").pipe(Config.withDefault(10))
})
type Settings = Config.Success<typeof Settings>

class BenchFailure extends Schema.TaggedError<BenchFailure>()("BenchFailure", {
  message: Schema.String
}) {}

const failWith = (message: string) => (error: unknown) => new BenchFailure({ message: `${message}: ${String(error)}` })

const attempt = <A>(what: string, run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failWith(what) })

const range = (count: number) => Array.from({ length: count }, (_, index) => index)

// ---------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------

/** The watcher the init script installs, as the page's global; every figure reported is stamped by it, in the page. */
const BENCH = "window.__bench"

type Condition =
  | { readonly selector: string; readonly count: number }
  | { readonly selector: string; readonly text: string }

/**
 * Runs in the page before any of its scripts. A `count` condition holds when at least that many
 * elements match the selector, a `text` one when the first match's trimmed text is that. It is
 * source text, not a function: the runner that executes this script (tsx) adds a helper to every
 * named function it compiles, and a serialized function would lack it in the page.
 *
 * - `contentSeen` resolves, and `firstContentAt` is set, the first time the first-content
 *   conditions hold;
 * - `arm(expect)` starts waiting for the next click; `wait()` resolves with the click's timestamp, the
 *   time of the first mutation callback after it at which `expect` holds, and the time of the frame
 *   after that. The mutation callback is stamped when it starts, before the conditions are checked, so
 *   the check's cost is not in the reading.
 */
const watcherSource = (firstContent: ReadonlyArray<Condition>) =>
  `(() => {
  const first = ${JSON.stringify(firstContent)}
  const holds = (condition) => {
    const nodes = document.querySelectorAll(condition.selector)
    if (condition.text === undefined) return nodes.length >= condition.count
    return nodes.length > 0 && nodes[0].textContent.trim() === condition.text
  }
  const allHold = (conditions) => conditions.every(holds)
  const bench = { firstContentAt: null, pending: null, done: null }
  let timer
  bench.contentSeen = new Promise((resolve, reject) => {
    bench.resolveContent = resolve
    timer = setTimeout(() => reject(new Error("no first content within ${CONTENT_TIMEOUT_MS} ms")), ${CONTENT_TIMEOUT_MS})
  })
  bench.arm = (expect) => {
    bench.done = new Promise((resolve, reject) => {
      bench.pending = { expect, clickAt: null, domAt: null, finish: resolve }
      setTimeout(() => reject(new Error("no update within ${UPDATE_TIMEOUT_MS} ms: " + JSON.stringify(expect))), ${UPDATE_TIMEOUT_MS})
    })
    bench.done.catch(() => {})
  }
  bench.wait = () => bench.done
  const onMutation = () => {
    const startedAt = performance.now()
    if (bench.firstContentAt === null && allHold(first)) {
      bench.firstContentAt = startedAt
      clearTimeout(timer)
      bench.resolveContent()
    }
    const pending = bench.pending
    if (pending === null || pending.clickAt === null || pending.domAt !== null || !allHold(pending.expect)) return
    pending.domAt = startedAt
    requestAnimationFrame(() => setTimeout(() => {
      pending.finish({ clickAt: pending.clickAt, domAt: pending.domAt, frameAt: performance.now() })
    }, 0))
  }
  document.addEventListener("click", (event) => {
    const pending = bench.pending
    if (pending !== null && pending.clickAt === null) pending.clickAt = event.timeStamp
  }, true)
  new MutationObserver(onMutation).observe(document, { childList: true, subtree: true, characterData: true })
  window.__bench = bench
})()`

const Timings = Schema.Struct({ clickAt: Schema.Number, domAt: Schema.Number, frameAt: Schema.Number })
const decodeTimings = Schema.decodeUnknownEffect(Timings)

// ---------------------------------------------------------------------------------------------
// What each page is and how it is used
// ---------------------------------------------------------------------------------------------

interface Step {
  readonly click: string
  readonly expect: ReadonlyArray<Condition>
}

/** Step `index`, called once per index in ascending order, so a plan may keep the state it expects the page to be in. */
type Steps = (index: number) => Step

/** Brings the loaded page to where its steps start, and reads from it what they are relative to. */
type Plan = (page: Page) => Promise<Steps>

interface Subject {
  readonly name: string
  readonly path: string
  readonly firstContent: ReadonlyArray<Condition>
  readonly plan: Plan
}

const integerOf = async (page: Page, selector: string) => {
  const text = await page.locator(selector).first().textContent()
  const value = Number(text)
  if (text === null || text.trim() === "" || !Number.isInteger(value)) {
    throw new Error(`${selector} holds ${JSON.stringify(text)}, not an integer`)
  }
  return value
}

const counterPlan: Plan = async (page) => {
  const start = await integerOf(page, "#count")
  return (index) => ({ click: "#inc", expect: [{ selector: "#count", text: String(start + index + 1) }] })
}

/** Row `(index * 37) % 1000` toggles each step; a row met twice toggles back, which the plan tracks. */
const listPlan: Plan = async (page) => {
  const start = await integerOf(page, "#on")
  const on = new Set<number>()
  return (index) => {
    const row = (index * ROW_STRIDE) % LIST_ROWS
    const turnsOn = !on.has(row)
    if (turnsOn) on.add(row)
    else on.delete(row)
    const button = `li[data-id="${row}"] button`
    return {
      click: button,
      expect: [
        { selector: button, text: turnsOn ? "on" : "off" },
        { selector: "#on", text: String(start + on.size) }
      ]
    }
  }
}

/** A bid of the amount the form already holds (the minimum), so every bid is valid; each adds one entry to the bid list. */
const auctionPlan: Plan = async (page) => {
  await page.waitForSelector("#app button.bid:not([disabled])", { timeout: CONTENT_TIMEOUT_MS })
  const start = await page.locator("#app ol.bids li").count()
  return (index) => ({
    click: "#app button.bid",
    expect: [{ selector: "#app ol.bids li", count: start + index + 1 }]
  })
}

const benchSubject = (page: BenchPage, firstContent: ReadonlyArray<Condition>, plan: Plan): Subject => ({
  name: page,
  path: `/${benchPages[page]}`,
  firstContent,
  plan
})

const counterContent: ReadonlyArray<Condition> = [{ selector: "#count", count: 1 }]
const listContent: ReadonlyArray<Condition> = [{ selector: "#rows li", count: LIST_ROWS }]

const subjectsOn = (auctionPage: string): ReadonlyArray<Subject> => [
  benchSubject("counter-uhtml", counterContent, counterPlan),
  benchSubject("counter-mufw", counterContent, counterPlan),
  benchSubject("list-uhtml", listContent, listPlan),
  benchSubject("list-mufw", listContent, listPlan),
  { name: AUCTION_NAME, path: `/${auctionPage}`, firstContent: [{ selector: "#app h1", count: 1 }], plan: auctionPlan }
]

// ---------------------------------------------------------------------------------------------
// Building and serving
// ---------------------------------------------------------------------------------------------

const isFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once("error", () => resolve(false))
    probe.listen(port, () => probe.close(() => resolve(true)))
  })

const freePort = Effect.gen(function*() {
  for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
    if (yield* Effect.promise(() => isFree(port))) return port
  }
  return yield* new BenchFailure({ message: `no free port in ${FIRST_PORT}-${LAST_PORT}` })
})

/**
 * One build per page, never several entries in one: a shared chunk would put code a page does not
 * need into its bundle, or a baseline's modules into µFW's.
 */
const buildBenchPage = (outDir: string, name: string, path: string) =>
  attempt(`building ${name}`, () =>
    build({
      root: AUCTION_ROOT,
      configFile: false,
      logLevel: "silent",
      build: { outDir, emptyOutDir: false, rollupOptions: { input: join(AUCTION_ROOT, path) } }
    }))

const buildAuction = (outDir: string) =>
  attempt(`building ${AUCTION_DEPLOYMENT}`, () =>
    build({ root: AUCTION_ROOT, mode: AUCTION_DEPLOYMENT, logLevel: "silent", build: { outDir, emptyOutDir: false } }))

const auctionPageOf = Effect.fn("auctionPageOf")(function*() {
  const page = pages[AUCTION_DEPLOYMENT]
  if (page === undefined) return yield* new BenchFailure({ message: `no page registered for ${AUCTION_DEPLOYMENT}` })
  return page
})

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "mufw-bench-browser-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
)

/**
 * Builds the four bench pages and the auction deployment into a temporary directory, which is
 * removed with the scope, and serves it on `port`. The server answers 404 for a missing file rather
 * than falling back to an html page.
 */
const servePages = Effect.fn("servePages")(function*(port: number) {
  const directory = yield* temporaryDirectory
  const outDir = join(directory, "dist")
  yield* Effect.forEach(Object.entries(benchPages), ([name, path]) => buildBenchPage(outDir, name, path))
  yield* buildAuction(outDir)
  yield* Effect.acquireRelease(
    attempt("serving the pages", () =>
      preview({
        root: AUCTION_ROOT,
        configFile: false,
        appType: "mpa",
        logLevel: "silent",
        build: { outDir },
        preview: { port, strictPort: true, host: "127.0.0.1" }
      })),
    (server) => Effect.promise(() => server.close())
  )
  return `http://127.0.0.1:${port}`
})

const launchBrowser = Effect.acquireRelease(
  attempt("launching Chromium", () => chromium.launch({ headless: true })),
  (browser) => Effect.promise(() => browser.close())
)

// ---------------------------------------------------------------------------------------------
// One page, in a context of its own
// ---------------------------------------------------------------------------------------------

interface Prepared {
  readonly page: Page
  readonly cdp: CDPSession
  readonly scriptBytes: () => Promise<number>
}

/** A page with the watcher installed, the CPU throttled to `rate`, and the sizes of the scripts it loads being collected. */
const preparePage = async (context: BrowserContext, firstContent: ReadonlyArray<Condition>, rate: number): Promise<Prepared> => {
  const page = await context.newPage()
  page.on("pageerror", (error) => console.error(`page error: ${error.message}`))
  await page.addInitScript({ content: watcherSource(firstContent) })
  const cdp = await context.newCDPSession(page)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate })
  await cdp.send("Performance.enable")
  await cdp.send("HeapProfiler.enable")
  const sizes: Array<Promise<number>> = []
  page.on("response", (response) => {
    if (!new URL(response.url()).pathname.endsWith(".js")) return
    const size = response.body().then((body) => body.byteLength)
    size.catch(() => {})
    sizes.push(size)
  })
  return { page, cdp, scriptBytes: () => Promise.all(sizes).then((all) => all.reduce((total, size) => total + size, 0)) }
}

const openContext = (browser: Browser) =>
  Effect.acquireRelease(
    attempt("opening a browser context", () => browser.newContext()),
    (context) => Effect.promise(() => context.close())
  )

/** Loads `url` and returns once the page has shown its first content. */
const loadPage = (prepared: Prepared, url: string) =>
  Effect.gen(function*() {
    yield* attempt(`loading ${url}`, () => prepared.page.goto(url, { waitUntil: "load" }))
    yield* attempt(`first content of ${url}`, () => prepared.page.evaluate(`${BENCH}.contentSeen`))
  })

/** The frame after the content, so work the page scheduled when it rendered is in the metrics. */
const settle = (page: Page) =>
  attempt("settling", () => page.evaluate("new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))"))

const MetricName = Schema.Literals(["ScriptDuration", "TaskDuration", "JSHeapUsedSize"])

const metricOf = (metrics: ReadonlyArray<{ readonly name: string; readonly value: number }>, name: typeof MetricName.Type) => {
  const metric = metrics.find((candidate) => candidate.name === name)
  return metric === undefined
    ? Effect.fail(new BenchFailure({ message: `Chromium reports no ${name}` }))
    : Effect.succeed(metric.value)
}

const SECONDS_TO_MS = 1_000
const BYTES_PER_MIB = 1024 * 1024

interface Load {
  readonly firstContentMs: number
  readonly scriptMs: number
  readonly taskMs: number
  readonly heapMiB: number
  readonly jsBytes: number
}

/** One cold load in a context of its own. */
const coldLoad = Effect.fn("coldLoad")(function*(browser: Browser, origin: string, subject: Subject, rate: number) {
  const context = yield* openContext(browser)
  const prepared = yield* attempt("preparing the page", () => preparePage(context, subject.firstContent, rate))
  yield* loadPage(prepared, `${origin}${subject.path}`)
  yield* settle(prepared.page)
  const firstContent = yield* attempt("reading the first content time", () => prepared.page.evaluate(`${BENCH}.firstContentAt`))
  const firstContentMs = yield* Schema.decodeUnknownEffect(Schema.Number)(firstContent).pipe(
    Effect.mapError(failWith("first content time"))
  )
  yield* attempt("collecting garbage", () => prepared.cdp.send("HeapProfiler.collectGarbage"))
  const { metrics } = yield* attempt("reading metrics", () => prepared.cdp.send("Performance.getMetrics"))
  const jsBytes = yield* attempt("sizing scripts", prepared.scriptBytes)
  return {
    firstContentMs,
    scriptMs: (yield* metricOf(metrics, "ScriptDuration")) * SECONDS_TO_MS,
    taskMs: (yield* metricOf(metrics, "TaskDuration")) * SECONDS_TO_MS,
    heapMiB: (yield* metricOf(metrics, "JSHeapUsedSize")) / BYTES_PER_MIB,
    jsBytes
  } satisfies Load
}, Effect.scoped)

/** The discarded load and then `loads` that count. */
const coldLoads = Effect.fn("coldLoads")(function*(run: Run, subject: Subject, rate: number) {
  yield* Effect.forEach(range(DISCARDED_LOADS), () => coldLoad(run.browser, run.origin, subject, rate))
  return yield* Effect.forEach(range(run.settings.loads), () => coldLoad(run.browser, run.origin, subject, rate))
})

interface Latency {
  readonly dom: number
  readonly frame: number
}

/** Arms the page, clicks, and reads the page's own stamps; the round trips to Playwright are outside them. */
const interact = Effect.fn("interact")(function*(page: Page, step: Step) {
  yield* attempt(`arming for ${step.click}`, () => page.evaluate(`${BENCH}.arm(${JSON.stringify(step.expect)})`))
  yield* attempt(`clicking ${step.click}`, () => page.click(step.click, { timeout: CLICK_TIMEOUT_MS }))
  const stamps = yield* attempt(`the update after ${step.click}`, () => page.evaluate(`${BENCH}.wait()`))
  const { clickAt, domAt, frameAt } = yield* decodeTimings(stamps).pipe(Effect.mapError(failWith("the page's timings")))
  if (domAt < clickAt || frameAt < domAt) {
    return yield* new BenchFailure({ message: `${step.click}: stamps out of order (${clickAt}, ${domAt}, ${frameAt})` })
  }
  return { dom: domAt - clickAt, frame: frameAt - clickAt } satisfies Latency
})

/** `warmupInteractions` clicks that do not count, then `interactions` that do, one at a time on one page. */
const interactions = Effect.fn("interactions")(function*(run: Run, subject: Subject, rate: number) {
  const { settings } = run
  const context = yield* openContext(run.browser)
  const prepared = yield* attempt("preparing the page", () => preparePage(context, subject.firstContent, rate))
  yield* loadPage(prepared, `${run.origin}${subject.path}`)
  const steps = yield* attempt(`planning ${subject.name}`, () => subject.plan(prepared.page))
  const indexes = range(settings.warmupInteractions + settings.interactions)
  const latencies = yield* Effect.forEach(indexes, (index) => interact(prepared.page, steps(index)))
  return latencies.slice(settings.warmupInteractions)
}, Effect.scoped)

// ---------------------------------------------------------------------------------------------
// The measured cases
// ---------------------------------------------------------------------------------------------

/** What every case shares: the browser, where the pages are served, and the settings. */
interface Run {
  readonly browser: Browser
  readonly origin: string
  readonly settings: Settings
}

interface Measured {
  readonly name: string
  readonly rate: number
  readonly firstContent: Summary
  readonly script: Summary
  readonly task: Summary
  readonly heap: Summary
  readonly jsBytes: Summary
  readonly dom: Summary
  readonly frame: Summary
}

const measureSubject = Effect.fn("measureSubject")(function*(run: Run, subject: Subject, rate: number) {
  const loads = yield* coldLoads(run, subject, rate)
  const latencies = yield* interactions(run, subject, rate)
  return {
    name: subject.name,
    rate,
    firstContent: summarize(loads.map((load) => load.firstContentMs)),
    script: summarize(loads.map((load) => load.scriptMs)),
    task: summarize(loads.map((load) => load.taskMs)),
    heap: summarize(loads.map((load) => load.heapMiB)),
    jsBytes: summarize(loads.map((load) => load.jsBytes)),
    dom: summarize(latencies.map((latency) => latency.dom)),
    frame: summarize(latencies.map((latency) => latency.frame))
  } satisfies Measured
})

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const medianAndP95 = (summary: Summary) => `${ms(summary.median)} / ${ms(summary.p95)}`

const HEADER = [
  "page",
  "first content ms (median / p95)",
  "script ms (median)",
  "task ms (median)",
  "heap MiB (median)",
  "JS KiB (raw)",
  "click→DOM ms (median / p95)",
  "click→next frame ms (median / p95)"
]

const columns = (measured: Measured) => [
  measured.name,
  medianAndP95(measured.firstContent),
  ms(measured.script.median),
  ms(measured.task.median),
  ms(measured.heap.median),
  kib(measured.jsBytes.median),
  medianAndP95(measured.dom),
  medianAndP95(measured.frame)
]

const ratio = (mufw: Summary, plain: Summary) => {
  const quotient = mufw.median / plain.median
  return Number.isFinite(quotient) ? `${quotient.toFixed(2)}×` : "n/a"
}

const RATIO_HEADER = [
  "throttle",
  "pair",
  "first content",
  "script",
  "task",
  "heap",
  "JS KiB",
  "click→DOM",
  "click→next frame"
]

interface Pair {
  readonly label: string
  readonly mufw: BenchPage
  readonly plain: BenchPage
}

const pairs: ReadonlyArray<Pair> = [
  { label: "counter", mufw: "counter-mufw", plain: "counter-uhtml" },
  { label: "list", mufw: "list-mufw", plain: "list-uhtml" }
]

const requireMeasured = (results: ReadonlyArray<Measured>, name: string) => {
  const found = results.find((measured) => measured.name === name)
  return found === undefined
    ? Effect.fail(new BenchFailure({ message: `no measurement for ${name}` }))
    : Effect.succeed(found)
}

const ratioRow = Effect.fn("ratioRow")(function*(rate: number, results: ReadonlyArray<Measured>, pair: Pair) {
  const mufw = yield* requireMeasured(results, pair.mufw)
  const plain = yield* requireMeasured(results, pair.plain)
  return [
    `${rate}×`,
    pair.label,
    ratio(mufw.firstContent, plain.firstContent),
    ratio(mufw.script, plain.script),
    ratio(mufw.task, plain.task),
    ratio(mufw.heap, plain.heap),
    ratio(mufw.jsBytes, plain.jsBytes),
    ratio(mufw.dom, plain.dom),
    ratio(mufw.frame, plain.frame)
  ]
})

const environment = (chromiumVersion: string) =>
  `node ${process.version} · ${cpus()[0]?.model ?? "unknown CPU"} · ${cpus().length} CPUs · ${
    (totalmem() / 2 ** 30).toFixed(1)
  } GiB · headless Chromium ${chromiumVersion}`

const reportRate = (rate: number, results: ReadonlyArray<Measured>) =>
  Console.log(
    [
      `\nCPU throttling ${rate}×: cold load (ms, MiB, KiB) and interaction latency (ms) per page`,
      table([HEADER, ...results.map(columns)])
    ].join("\n")
  )

const program = Effect.gen(function*() {
  const settings = yield* Settings
  const auctionPage = yield* auctionPageOf()
  const port = yield* freePort
  const origin = yield* servePages(port)
  const browser = yield* launchBrowser
  const run: Run = { browser, origin, settings }
  const subjects = subjectsOn(auctionPage)
  yield* Console.log(environment(browser.version()))
  yield* Console.log(
    `${settings.loads} cold loads per page (after ${DISCARDED_LOADS} discarded) and ${settings.interactions} interactions (after ${settings.warmupInteractions} warm-up), at CPU throttling ${
      settings.cpuRates.join(", ")
    }×`
  )
  const perRate = yield* Effect.forEach(settings.cpuRates, (rate) =>
    Effect.gen(function*() {
      const results = yield* Effect.forEach(subjects, (subject) => measureSubject(run, subject, rate))
      yield* reportRate(rate, results)
      return { rate, results }
    }))
  const rows = yield* Effect.forEach(
    perRate.flatMap(({ rate, results }) => pairs.map((pair) => ({ rate, results, pair }))),
    ({ rate, results, pair }) => ratioRow(rate, results, pair)
  )
  yield* Console.log(
    `\nµFW ÷ uhtml baseline, ratio of medians (above 1 means µFW costs more)\n${table([RATIO_HEADER, ...rows])}`
  )
}).pipe(Effect.scoped)

NodeRuntime.runMain(program)
