import { NodeRuntime, NodeSocket } from "@effect/platform-node"
import type { DispatchRefused, HistoryPortShape, IntentPortShape, ModelPortShape } from "@mufw/core"
import { Cause, Config, Console, Context, Effect, Layer, Option, Schedule, Schema, Semaphore, Stream } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { type ChildProcess, spawn } from "node:child_process"
import { connect, createServer } from "node:net"
import { cpus, totalmem } from "node:os"
import { fileURLToPath } from "node:url"
import { layerAuthenticationAnonymous, layerAuthenticationClient } from "../src/authentication.ts"
import { Auction, type Proposal } from "../src/auction/Auction.ts"
import { Amount, Bidder, SessionToken } from "../src/domain/Values.ts"
import { Ports, Rpc } from "../src/ports.ts"
import { samPath } from "../src/samPath.ts"
import { EVENT_LOG_PATH } from "../src/sync.ts"
import { summarize, table } from "./stats.ts"

/**
 * What one µFW server process costs and sustains, measured from outside: a child process running
 * `src/server.ts` (automatic actions off, a fresh `Auction.initial` for every row) and this process
 * driving it over the real remote adapters (`Rpc.layerClient` on a JSON websocket). Six scenarios,
 * one table each:
 *
 * 1. `Present` round trip, one client, one step after the other: latency and steps per second.
 * 2. The same with 1, 10, 50, 200 connections: one definition is one serialised writer, so the
 *    total should not grow with the connections; latency does.
 * 3. `Submit` (the server runs the action behind the authentication middleware) with 1 and 50
 *    connections. `Submit` is answered when the intent is queued, not when its step is applied, so
 *    the latency column is the acknowledgement; the steps actually applied, and the time the
 *    server needed to catch up after the load stopped, are read from `History`.
 * 4. Fan-out: S websocket subscribers to `Representations`, one `Present` every 20 ms; the delay
 *    from sending an update to the moment the last subscriber has a representation that includes it.
 * 5. Server memory (RSS and V8 heap used) when idle, after 1000 steps (the history's record
 *    limit) and after 5000; the history also stops at `HistoryRetainedSize` of estimated size.
 * 6. `Present` against a synced host and against a joiner of its log (`MUFW_SYNC`), next to the
 *    same client against a server without sync.
 *
 * What the numbers are not. Everything runs on one machine over loopback, with no TLS and no
 * network latency, so they compare what the framework and the wire format cost, not a real link.
 * The load generator is one Node thread on the same CPUs as the server; with many connections it
 * can be the bottleneck, which is why its CPU is reported (about 100% means the generator, not
 * the server, limits the row). The server runs through `tsx`, not a production build; each row
 * starts a cold process and warms it with about 200 steps, and JIT work still going on after that
 * lands in the first samples of the window. Load is closed-loop (a
 * connection sends its next request when the last one is answered), so a saturated server shows as
 * lower throughput and longer round trips, not as a growing queue of late requests. The server's
 * RSS is read without forcing a garbage collection. Every bid changes the model, whose `bids`
 * array grows with the steps (it is not bounded like the history), so a step costs more late in a
 * run than early: the `last/first fifth` column is the median latency of the last fifth of the
 * samples over the first fifth's.
 *
 * Server CPU and memory come from the process itself: a preload module in the child answers an IPC
 * message with `process.cpuUsage()` and `process.memoryUsage()`, asked every 250 ms and once at the
 * start and end of each measured window. CPU is a percentage of one core (200 means two cores busy,
 * V8's helper threads and garbage collector included). `ps` is not used: its CPU columns do not
 * report an interval's usage.
 *
 * Not measured: TLS and HTTP/2, a store (`MUFW_STORE`), automatic actions, the HTTP and HTML-stream
 * routes, the browser, and more than one server process.
 *
 * Settings (all optional): `BENCH_SECONDS` per measured window (5), `BENCH_SCENARIOS` the numbers to
 * run (1,2,3,4,5,6), `BENCH_PRESENTERS` (1,10,50,200), `BENCH_SUBMITTERS` (1,50), `BENCH_SUBSCRIBERS`
 * (1,100,500,1000; drop the large values to open fewer sockets), `BENCH_MEMORY_STEPS` (1000,5000),
 * `BENCH_SYNC_BIDS` timed bids per row of scenario 6 (2000).
 */

const AUCTION_ROOT = fileURLToPath(new URL("..", import.meta.url))

/** Ports are taken from here, so the dev servers (:3001, :5173), compare-transports (4700-4799) and the browser bench (4600-4699) are left alone. */
const FIRST_PORT = 4800
const LAST_PORT = 4999

/** Everything the scenarios call; `TravelTo` and `Replay` are left out, which a synced instance requires. */
const SERVED_RPCS = "Submit,Present,Representations,History"

const SAMPLE_INTERVAL = "250 millis"

/** CPU measured over less than this is dominated by the clock's resolution, so it is not a candidate for the maximum. */
const MIN_CPU_INTERVAL_MS = 100

const WARMUP_STEPS = 200
const OPEN_CONCURRENCY = 25
const FANOUT_INTERVAL_MS = 20
const FANOUT_UPDATES_PER_SECOND = 1000 / FANOUT_INTERVAL_MS
const CONNECT_TIMEOUT_MS = 15_000
const DELIVERY_TIMEOUT_MS = 10_000
const DRAIN_LIMIT_MS = 30_000
const HISTORY_PROBE_MS = 2_000
const IDLE_SETTLE = "1 second"
const PROCESS_STOP_GRACE_MS = 3_000

const Settings = Config.all({
  seconds: Config.Int("BENCH_SECONDS").pipe(Config.withDefault(5)),
  scenarios: Config.Array(Schema.Int, "BENCH_SCENARIOS").pipe(Config.withDefault([1, 2, 3, 4, 5, 6])),
  presenters: Config.Array(Schema.Int, "BENCH_PRESENTERS").pipe(Config.withDefault([1, 10, 50, 200])),
  submitters: Config.Array(Schema.Int, "BENCH_SUBMITTERS").pipe(Config.withDefault([1, 50])),
  subscribers: Config.Array(Schema.Int, "BENCH_SUBSCRIBERS").pipe(Config.withDefault([1, 100, 500, 1000])),
  memorySteps: Config.Array(Schema.Int, "BENCH_MEMORY_STEPS").pipe(Config.withDefault([1000, 5000])),
  syncBids: Config.Int("BENCH_SYNC_BIDS").pipe(Config.withDefault(2000))
})
type Settings = Config.Success<typeof Settings>

class BenchFailure extends Schema.TaggedError<BenchFailure>()("BenchFailure", {
  message: Schema.String
}) {}

const failWith = (message: string) => (error: unknown) => new BenchFailure({ message: `${message}: ${String(error)}` })

const range = (count: number) => Array.from({ length: count }, (_, index) => index)

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

// `stats.ms` has one decimal, too coarse for a round trip of a few tenths of a millisecond.
const fixed = (digits: number) => (value: number) => Number.isFinite(value) ? value.toFixed(digits) : "n/a"
const whole = fixed(0)
const one = fixed(1)
const two = fixed(2)

const meanMax = (mean: number, max: number, format: (value: number) => string) => `${format(mean)} / ${format(max)}`

const mib = (kib: number) => one(kib / 1024)

const rate = (count: number, seconds: number) => whole(count / seconds)

const heading = (number: number, text: string) => Console.log(`\n## ${number}. ${text}`)

const environment = (settings: Settings) => {
  const processors = cpus()
  const memory = (totalmem() / 2 ** 30).toFixed(1)
  const machine = `${processors[0]?.model ?? "unknown CPU"}, ${processors.length} CPUs, ${memory} GiB`
  return `# µFW server benchmark: node ${process.version} on ${process.platform}/${process.arch}, ${machine}, ${settings.seconds} s per measured window`
}

// ---------------------------------------------------------------------------------------------
// The server process
// ---------------------------------------------------------------------------------------------

const isFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once("error", () => resolve(false))
    probe.listen(port, () => probe.close(() => resolve(true)))
  })

let nextPort = FIRST_PORT

/** Each claim moves on, so two servers started in a row never race for the same port; a port is taken only if nothing listens on it. */
const claimPort = Effect.fn("claimPort")(function*() {
  for (let attempts = LAST_PORT - FIRST_PORT + 1; attempts > 0; attempts--) {
    const port = nextPort
    nextPort = port === LAST_PORT ? FIRST_PORT : port + 1
    if (yield* Effect.promise(() => isFree(port))) return port
  }
  return yield* new BenchFailure({ message: `no free port in ${FIRST_PORT}-${LAST_PORT}` })
})

/** The server's settings come from here alone: a `MUFW_*` variable of the caller must not change what is measured. */
const serverEnv = (port: number, extra: Readonly<Record<string, string>>) => {
  const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith("MUFW_"))
  return {
    ...Object.fromEntries(inherited),
    MUFW_PORT: String(port),
    MUFW_AUTO_ACTIONS: "off",
    MUFW_RPCS: SERVED_RPCS,
    ...extra
  }
}

/**
 * Preloaded into the server: answers `"sample"` on the IPC channel with the process's own CPU time
 * and memory. The channel is unreferenced so that it never keeps the process alive after the
 * server has shut down.
 */
const MEASURE_HOOK = `process.on("message", (message) => {
  if (message !== "sample") return
  const cpu = process.cpuUsage()
  const memory = process.memoryUsage()
  process.send({
    at: performance.now(),
    cpuMs: (cpu.user + cpu.system) / 1000,
    rssKib: Math.round(memory.rss / 1024),
    heapUsedKib: Math.round(memory.heapUsed / 1024)
  })
})
process.channel?.unref()`

const MEASURE_HOOK_URL = `data:text/javascript,${encodeURIComponent(MEASURE_HOOK)}`

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

interface Server {
  readonly child: ChildProcess
  readonly port: number
}

/** A server with the auction fresh and no automatic actions, with `extra` settings (`MUFW_SYNC`); stopped with the scope. */
const startServer = Effect.fn("startServer")(function*(port: number, extra: Readonly<Record<string, string>> = {}) {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawn(process.execPath, ["--import", "tsx", "--import", MEASURE_HOOK_URL, "src/server.ts"], {
        cwd: AUCTION_ROOT,
        env: serverEnv(port, extra),
        stdio: ["ignore", "ignore", "inherit", "ipc"]
      })
    ),
    stopProcess
  )
  yield* untilListening(port)
  return { child, port } satisfies Server
})

// ---------------------------------------------------------------------------------------------
// Sampling the server's CPU and memory
// ---------------------------------------------------------------------------------------------

const Reading = Schema.Struct({
  at: Schema.Number,
  cpuMs: Schema.Number,
  rssKib: Schema.Number,
  heapUsedKib: Schema.Number
})

/** `at` and `cpuMs` are the server's own clock and CPU time; `observedAt` is this process's clock at the midpoint of the question. */
type Sample = typeof Reading.Type & { readonly observedAt: number }

const ask = (child: ChildProcess) =>
  new Promise<unknown>((resolve, reject) => {
    const detach = () => {
      child.off("message", answered)
      child.off("exit", gone)
    }
    const answered = (message: unknown) => {
      detach()
      resolve(message)
    }
    const gone = () => {
      detach()
      reject(new Error("the server exited"))
    }
    child.on("message", answered)
    child.once("exit", gone)
    child.send("sample", (error) => {
      if (error === null) return
      detach()
      reject(error)
    })
  })

const decodeReading = Schema.decodeUnknownEffect(Reading)

/** One question to the server; callers must not overlap, since an answer is matched to the question by order alone. */
const sampleOnce = (child: ChildProcess) =>
  Effect.gen(function*() {
    const asked = performance.now()
    const answer = yield* Effect.tryPromise({ try: () => ask(child), catch: failWith("asking the server for a sample") })
    const reading = yield* decodeReading(answer).pipe(Effect.mapError(failWith("decoding the server's sample")))
    return { ...reading, observedAt: (asked + performance.now()) / 2 } satisfies Sample
  })

interface Sampler {
  readonly samples: ReadonlyArray<Sample>
  readonly sampleNow: Effect.Effect<Sample, BenchFailure>
}

/** Samples `child` every 250 ms until the scope ends; `sampleNow` takes one more, in line with those. */
const startSampler = Effect.fn("startSampler")(function*(child: ChildProcess) {
  const samples: Array<Sample> = []
  const gate = Semaphore.makeUnsafe(1)
  const record = (sample: Sample) => Effect.sync(() => void samples.push(sample))
  const sampleNow = gate.withPermits(1)(sampleOnce(child).pipe(Effect.tap(record)))
  yield* sampleNow
  yield* sampleNow.pipe(Effect.andThen(Effect.sleep(SAMPLE_INTERVAL)), Effect.forever, Effect.forkScoped)
  return { samples, sampleNow } satisfies Sampler
})

interface Usage {
  /** Percent of one core. */
  readonly cpuMean: number
  readonly cpuMax: number
  readonly rssMeanKib: number
  readonly rssMaxKib: number
}

const cpuPercent = (before: Sample, after: Sample) => ((after.cpuMs - before.cpuMs) / (after.at - before.at)) * 100

/** The samples from the last one at or before `from` to the first one at or after `to`. */
const windowOf = (samples: ReadonlyArray<Sample>, from: number, to: number) => {
  const first = Math.max(0, samples.findLastIndex((sample) => sample.observedAt <= from))
  const afterEnd = samples.findIndex((sample) => sample.observedAt >= to)
  const last = afterEnd === -1 ? samples.length - 1 : afterEnd
  return samples.slice(first, last + 1)
}

const intervalPercents = (window: ReadonlyArray<Sample>) => {
  const percents: Array<number> = []
  for (let index = 1; index < window.length; index++) {
    const before = window[index - 1]
    const after = window[index]
    if (before === undefined || after === undefined) continue
    if (after.at - before.at >= MIN_CPU_INTERVAL_MS) percents.push(cpuPercent(before, after))
  }
  return percents
}

const usageOf = (window: ReadonlyArray<Sample>): Usage => {
  const first = window[0]
  const last = window.at(-1)
  const rss = window.map((sample) => sample.rssKib)
  const percents = intervalPercents(window)
  return {
    cpuMean: first === undefined || last === undefined ? Number.NaN : cpuPercent(first, last),
    cpuMax: percents.length === 0 ? Number.NaN : Math.max(...percents),
    rssMeanKib: rss.length === 0 ? Number.NaN : rss.reduce((sum, value) => sum + value, 0) / rss.length,
    rssMaxKib: rss.length === 0 ? Number.NaN : Math.max(...rss)
  }
}

interface Measured<A> {
  readonly value: A
  readonly seconds: number
  readonly usage: Usage
  /** This process's own CPU, percent of one core: near 100 means the load generator limits the row. */
  readonly loadGenCpu: number
}

/** Runs `work` and reports what the server used while it ran. Wall-clock `performance.now()`, as the server's samples are in another process that `Clock` cannot time. */
const measure = <A, E, R>(sampler: Sampler, work: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    yield* sampler.sampleNow
    const ownBefore = process.cpuUsage()
    const from = performance.now()
    const value = yield* work
    const to = performance.now()
    const own = process.cpuUsage(ownBefore)
    yield* sampler.sampleNow
    const elapsedMs = to - from
    return {
      value,
      seconds: elapsedMs / 1000,
      usage: usageOf(windowOf(sampler.samples, from, to)),
      loadGenCpu: ((own.user + own.system) / 1000 / elapsedMs) * 100
    } satisfies Measured<A>
  })

// ---------------------------------------------------------------------------------------------
// The load generator's connections
// ---------------------------------------------------------------------------------------------

type Authentication = typeof layerAuthenticationAnonymous

const asBob = layerAuthenticationClient(SessionToken.make("demo-bob"))

/** The remote ports over a websocket of their own, which lives as long as the scope. */
const open = (port: number, authentication: Authentication) => {
  const client = Rpc.layerClient.pipe(
    Layer.provide(authentication),
    Layer.provide(RpcClient.layerProtocolSocket()),
    Layer.provide(NodeSocket.layerWebSocket(`ws://127.0.0.1:${port}${samPath(Auction)}`)),
    Layer.provide(RpcSerialization.layerJson)
  )
  const ports = Layer.mergeAll(Rpc.layerModelRemote, Rpc.layerIntentPortRemote, Rpc.layerHistoryRemote)
  return Layer.build(ports.pipe(Layer.provide(client))).pipe(
    Effect.map((context) => ({
      model: Context.get(context, Ports.ModelPort),
      intents: Context.get(context, Ports.IntentPort),
      history: Context.get(context, Ports.HistoryPort)
    }))
  )
}

/** The three remote ports of one connection. */
interface Connection {
  readonly model: ModelPortShape<typeof Auction>
  readonly intents: IntentPortShape<typeof Auction>
  readonly history: HistoryPortShape<typeof Auction>
}

const openAll = (port: number, authentication: Authentication, count: number) =>
  Effect.forEach(range(count), () => open(port, authentication), { concurrency: OPEN_CONCURRENCY })

const currentBids = (connection: Connection) =>
  connection.model.representations.pipe(
    Stream.runHead,
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new BenchFailure({ message: "the server sent no representation" })),
      onSome: (representation) => Effect.succeed(representation.bids.length)
    }))
  )

// ---------------------------------------------------------------------------------------------
// What the load sends
// ---------------------------------------------------------------------------------------------

const opened: Proposal = { _tag: "Opened", at: 1_000 }

/** Bid `index` is valid when it arrives after bid `index - 1` (the minimum increment is 5). */
const bidNumber = (index: number): Proposal => ({
  _tag: "BidPlaced",
  bidder: Bidder.make(`x${index}x`),
  amount: Amount.make(5 * (index + 1)),
  at: 1_000 + index
})

/** One increasing sequence shared by every connection, so the bids are valid whichever connection sends them. */
interface Counter {
  next(): number
  issued(): number
}

const makeCounter = (): Counter => {
  let issued = 0
  return { next: () => ++issued, issued: () => issued }
}

type Step<E> = () => Effect.Effect<void, E>

const presentStep = (connection: Connection, counter: Counter): Step<never> => () =>
  connection.model.present(bidNumber(counter.next()))

// ---------------------------------------------------------------------------------------------
// Closed-loop load
// ---------------------------------------------------------------------------------------------

/** Each step is timed from just before it is sent to the moment its answer arrives. */
const stepsUntil = <E>(deadline: number, step: Step<E>, latencies: Array<number>) =>
  Effect.gen(function*() {
    while (performance.now() < deadline) {
      const started = performance.now()
      yield* step()
      latencies.push(performance.now() - started)
    }
  })

/** Round-trip times in the order the answers arrived, from every connection. */
const runClosedLoop = <E>(steps: ReadonlyArray<Step<E>>, seconds: number) =>
  Effect.gen(function*() {
    const latencies: Array<number> = []
    const deadline = performance.now() + seconds * 1000
    yield* Effect.forEach(steps, (step) => stepsUntil(deadline, step, latencies), {
      concurrency: "unbounded",
      discard: true
    })
    return latencies
  })

/** About `WARMUP_STEPS` steps in all, so the server's JIT and the sockets are warm before anything is timed. */
const warmUp = <E>(steps: ReadonlyArray<Step<E>>) => {
  const rounds = Math.max(1, Math.ceil(WARMUP_STEPS / steps.length))
  return Effect.forEach(
    steps,
    (step) => Effect.forEach(range(rounds), () => step(), { discard: true }),
    { concurrency: "unbounded", discard: true }
  )
}

const driveClosedLoop = <E>(sampler: Sampler, steps: ReadonlyArray<Step<E>>, seconds: number) =>
  warmUp(steps).pipe(Effect.andThen(measure(sampler, runClosedLoop(steps, seconds))))

/** Median of the last fifth of the samples over the first fifth's: above 1, a step costs more late in the run. */
const drift = (latencies: ReadonlyArray<number>) => {
  const fifth = Math.floor(latencies.length / 5)
  if (fifth === 0) return Number.NaN
  return summarize(latencies.slice(-fifth)).median / summarize(latencies.slice(0, fifth)).median
}

const latencyColumns = (latencies: ReadonlyArray<number>) => {
  const summary = summarize(latencies)
  return [two(summary.median), two(summary.p95), two(summary.p99), two(summary.max)]
}

const usageColumns = (usage: Usage) => [
  meanMax(usage.cpuMean, usage.cpuMax, whole),
  meanMax(usage.rssMeanKib / 1024, usage.rssMaxKib / 1024, one)
]

// ---------------------------------------------------------------------------------------------
// Scenarios 1 and 2: Present
// ---------------------------------------------------------------------------------------------

interface PresentOutcome {
  readonly run: Measured<ReadonlyArray<number>>
  /** Bids sent, warm-up included. */
  readonly sent: number
  /** Bids the auction accepted: the rest were out of order on arrival and rejected. */
  readonly accepted: number
}

/** A fresh server and `connections` presenters, each sending one bid after the other. */
const presentOutcome = (connections: number, seconds: number) =>
  Effect.scoped(Effect.gen(function*() {
    const server = yield* startServer(yield* claimPort())
    const sampler = yield* startSampler(server.child)
    const presenters = yield* openAll(server.port, layerAuthenticationAnonymous, connections)
    const control = yield* open(server.port, layerAuthenticationAnonymous)
    const counter = makeCounter()
    yield* control.model.present(opened)
    const steps = presenters.map((presenter) => presentStep(presenter, counter))
    const run = yield* driveClosedLoop(sampler, steps, seconds)
    const accepted = yield* currentBids(control)
    return { run, sent: counter.issued(), accepted } satisfies PresentOutcome
  }))

const PRESENT_HEADER = [
  "connections",
  "steps/s",
  "p50 ms",
  "p95 ms",
  "p99 ms",
  "max ms",
  "last/first fifth",
  "bids sent",
  "bids in model at end",
  "server CPU % mean / max",
  "server RSS MiB mean / max",
  "load generator CPU %"
]

const presentRow = (connections: number, outcome: PresentOutcome) => {
  const { loadGenCpu, seconds, usage, value: latencies } = outcome.run
  return [
    String(connections),
    rate(latencies.length, seconds),
    ...latencyColumns(latencies),
    `${two(drift(latencies))}x`,
    String(outcome.sent),
    String(outcome.accepted),
    ...usageColumns(usage),
    whole(loadGenCpu)
  ]
}

const presentTable = (settings: Settings, connectionCounts: ReadonlyArray<number>) =>
  Effect.gen(function*() {
    const rows: Array<ReadonlyArray<string>> = []
    for (const connections of connectionCounts) {
      rows.push(presentRow(connections, yield* presentOutcome(connections, settings.seconds)))
    }
    yield* Console.log(table([PRESENT_HEADER, ...rows]))
  })

const presentSequential = (settings: Settings) =>
  heading(1, "Present round trip, one client, one bid after the other: latency in ms per step, steps/s, server CPU and RSS during the window. Every step copies the model's bids array, so cost grows with the number of bids in the model; the history keeps up to 1000 records and 64 MiB of estimated retained size (HistoryRetainedSize), so the copies it holds are bounded by whichever limit is reached first").pipe(
    Effect.andThen(presentTable(settings, [1]))
  )

const presentConcurrent = (settings: Settings) =>
  heading(2, "Present with N connections, each sequential, bids from one shared counter: total steps/s, latency in ms per step across all connections. Every step copies the model's bids array, so cost grows with the number of bids in the model; the history keeps up to 1000 records and 64 MiB of estimated retained size (HistoryRetainedSize), so the copies it holds are bounded by whichever limit is reached first").pipe(
    Effect.andThen(presentTable(settings, settings.presenters))
  )

// ---------------------------------------------------------------------------------------------
// Scenario 3: Submit
// ---------------------------------------------------------------------------------------------

/** The highest `seq` of the retained history, read as far as `expected`, or what arrives within the probe window. */
const appliedSeq = (connection: Connection, expected: number) =>
  Effect.gen(function*() {
    let last = -1
    const reading = connection.history.records.pipe(
      Stream.takeUntil((record) => record.seq >= expected),
      Stream.runForEach((record) => Effect.sync(() => void (last = record.seq)))
    )
    yield* reading.pipe(Effect.timeoutOption(HISTORY_PROBE_MS))
    return last
  })

interface Applied {
  readonly applied: number
  readonly waitedMs: number
}

/** Polls the history until `expected` steps have been applied or the drain limit has passed. */
const awaitApplied = (connection: Connection, expected: number) =>
  Effect.gen(function*() {
    const started = performance.now()
    let applied = yield* appliedSeq(connection, expected)
    while (applied < expected && performance.now() - started < DRAIN_LIMIT_MS) {
      applied = yield* appliedSeq(connection, expected)
    }
    return { applied, waitedMs: performance.now() - started } satisfies Applied
  })

interface SubmitOutcome {
  readonly run: Measured<ReadonlyArray<number>>
  readonly submitted: number
  readonly caught: Applied
  readonly accepted: number
}

/** A fresh server, `connections` clients with a session, and the time the server needs after the load to apply what was queued. */
const submitOutcome = (connections: number, seconds: number) =>
  Effect.scoped(Effect.gen(function*() {
    const server = yield* startServer(yield* claimPort())
    const sampler = yield* startSampler(server.child)
    const submitters = yield* openAll(server.port, asBob, connections)
    const control = yield* open(server.port, asBob)
    const counter = makeCounter()
    yield* control.intents.dispatch({ _tag: "Open" })
    yield* awaitApplied(control, 1)
    const steps = submitters.map((submitter): Step<DispatchRefused> => () =>
      submitter.intents.dispatch({ _tag: "PlaceBid", amount: Amount.make(5 * (counter.next() + 1)) })
    )
    const run = yield* driveClosedLoop(sampler, steps, seconds)
    const submitted = counter.issued() + 1
    const caught = yield* awaitApplied(control, submitted)
    const accepted = yield* currentBids(control)
    return { run, submitted, caught, accepted } satisfies SubmitOutcome
  }))

const SUBMIT_HEADER = [
  "connections",
  "acks/s",
  "ack p50 ms",
  "ack p95 ms",
  "ack p99 ms",
  "ack max ms",
  "applied / submitted",
  "applied steps/s",
  "catch-up s",
  "accepted / rejected",
  "server CPU % mean / max",
  "server RSS MiB mean / max",
  "load generator CPU %"
]

const submitRow = (connections: number, outcome: SubmitOutcome) => {
  const { loadGenCpu, seconds, usage, value: latencies } = outcome.run
  const { applied, waitedMs } = outcome.caught
  // `Open` is the first step; the rest are bids, accepted or rejected (credit limit, minimum).
  const rejected = applied - 1 - outcome.accepted
  return [
    String(connections),
    rate(latencies.length, seconds),
    ...latencyColumns(latencies),
    `${applied} / ${outcome.submitted}`,
    rate(applied, seconds + waitedMs / 1000),
    one(waitedMs / 1000),
    `${outcome.accepted} / ${rejected}`,
    ...usageColumns(usage),
    whole(loadGenCpu)
  ]
}

const submitScenario = (settings: Settings) =>
  Effect.gen(function*() {
    yield* heading(
      3,
      "Submit as one session (bob, credit limit 1000) with N connections: acknowledgement latency in ms, acks/s, and the steps the server applied (from History) with the time it needed to catch up after the load stopped; CPU and RSS are those of the load window"
    )
    const rows: Array<ReadonlyArray<string>> = []
    for (const connections of settings.submitters) {
      rows.push(submitRow(connections, yield* submitOutcome(connections, settings.seconds)))
    }
    yield* Console.log(table([SUBMIT_HEADER, ...rows]))
  })

// ---------------------------------------------------------------------------------------------
// Scenario 4: fan-out
// ---------------------------------------------------------------------------------------------

/** What one subscriber has seen: the first time its representation held each number of bids. */
class Subscriber {
  connected = false
  failure: string | undefined = undefined
  readonly arrivals: Float64Array
  private seen = 0

  constructor(updates: number) {
    this.arrivals = new Float64Array(updates + 1).fill(Number.NaN)
  }

  /** A representation with `count` bids includes every update up to it, also those a slow reader skipped. */
  receive(count: number, at: number) {
    this.connected = true
    const last = Math.min(count, this.arrivals.length - 1)
    for (let update = this.seen + 1; update <= last; update++) this.arrivals[update] = at
    this.seen = Math.max(this.seen, count)
  }

  hasSeen(updates: number) {
    return this.seen >= updates
  }

  get live() {
    return this.connected && this.failure === undefined
  }
}

const subscribe = (port: number, subscriber: Subscriber) =>
  Effect.scoped(Effect.gen(function*() {
    const connection = yield* open(port, layerAuthenticationAnonymous)
    yield* connection.model.representations.pipe(
      Stream.runForEach((representation) =>
        Effect.sync(() => subscriber.receive(representation.bids.length, performance.now()))
      )
    )
  }))

const awaitConnected = (subscriber: Subscriber) =>
  Effect.gen(function*() {
    const limit = performance.now() + CONNECT_TIMEOUT_MS
    while (!subscriber.connected && subscriber.failure === undefined && performance.now() < limit) {
      yield* Effect.sleep("10 millis")
    }
    if (!subscriber.connected && subscriber.failure === undefined) {
      subscriber.failure = `no representation within ${CONNECT_TIMEOUT_MS} ms`
    }
  })

/** Subscribes in a fiber of the scope and returns once its first representation has arrived, or it has failed. */
const startSubscriber = (port: number, subscriber: Subscriber) =>
  Effect.gen(function*() {
    const failed = (cause: Cause.Cause<unknown>) =>
      Effect.sync(() => {
        subscriber.failure = Cause.pretty(cause)
      })
    yield* subscribe(port, subscriber).pipe(Effect.catchCause(failed), Effect.forkScoped)
    yield* awaitConnected(subscriber)
  })

/** Update `update` is sent `update * 20` ms after the first, or at once if the server has made the sender late. */
const sendUpdates = (presenter: Connection, sentAt: Float64Array) =>
  Effect.gen(function*() {
    const origin = performance.now()
    for (let update = 1; update < sentAt.length; update++) {
      const wait = origin + update * FANOUT_INTERVAL_MS - performance.now()
      if (wait > 0) yield* Effect.sleep(wait)
      sentAt[update] = performance.now()
      yield* presenter.model.present(bidNumber(update))
    }
  })

const awaitDelivery = (subscribers: ReadonlyArray<Subscriber>, updates: number) =>
  Effect.gen(function*() {
    const limit = performance.now() + DELIVERY_TIMEOUT_MS
    const pending = () => subscribers.filter((subscriber) => subscriber.live && !subscriber.hasSeen(updates))
    while (pending().length > 0 && performance.now() < limit) yield* Effect.sleep("10 millis")
  })

interface Delivery {
  /** Per update the subscribers all have, the time from sending it to the last of them receiving it. */
  readonly delays: ReadonlyArray<number>
  readonly updates: number
}

const deliveryOf = (subscribers: ReadonlyArray<Subscriber>, sentAt: Float64Array): Delivery => {
  const live = subscribers.filter((subscriber) => subscriber.live)
  const delays: Array<number> = []
  for (let update = 1; update < sentAt.length; update++) {
    const arrivals = live.map((subscriber) => subscriber.arrivals[update] ?? Number.NaN)
    const last = arrivals.reduce((latest, arrival) => Math.max(latest, arrival), Number.NEGATIVE_INFINITY)
    const sent = sentAt[update] ?? Number.NaN
    if (live.length > 0 && Number.isFinite(last)) delays.push(last - sent)
  }
  return { delays, updates: sentAt.length - 1 }
}

interface FanOutOutcome {
  readonly requested: number
  readonly connected: number
  readonly firstFailure: string | undefined
  readonly run: Measured<Delivery>
}

/** A fresh server, `requested` subscribers opened a few at a time, then the updates. */
const fanOutOutcome = (requested: number, seconds: number) =>
  Effect.scoped(Effect.gen(function*() {
    const server = yield* startServer(yield* claimPort())
    const sampler = yield* startSampler(server.child)
    const presenter = yield* open(server.port, layerAuthenticationAnonymous)
    yield* presenter.model.present(opened)
    const updates = seconds * FANOUT_UPDATES_PER_SECOND
    const subscribers = range(requested).map(() => new Subscriber(updates))
    yield* Effect.forEach(subscribers, (subscriber) => startSubscriber(server.port, subscriber), {
      concurrency: OPEN_CONCURRENCY,
      discard: true
    })
    const sentAt = new Float64Array(updates + 1).fill(Number.NaN)
    const delivering = sendUpdates(presenter, sentAt).pipe(
      Effect.andThen(awaitDelivery(subscribers, updates)),
      Effect.map(() => deliveryOf(subscribers, sentAt))
    )
    const run = yield* measure(sampler, delivering)
    const connected = subscribers.filter((subscriber) => subscriber.connected).length
    const firstFailure = subscribers.find((subscriber) => subscriber.failure !== undefined)?.failure
    return { requested, connected, firstFailure, run } satisfies FanOutOutcome
  }))

const FANOUT_HEADER = [
  "subscribers connected / requested",
  "updates delivered to all / sent",
  "delay p50 ms",
  "delay p95 ms",
  "delay max ms",
  "server CPU % mean / max",
  "server RSS MiB mean / max",
  "load generator CPU %"
]

const fanOutRow = (outcome: FanOutOutcome) => {
  const { loadGenCpu, usage, value: delivery } = outcome.run
  const summary = summarize(delivery.delays)
  return [
    `${outcome.connected} / ${outcome.requested}`,
    `${delivery.delays.length} / ${delivery.updates}`,
    two(summary.median),
    two(summary.p95),
    two(summary.max),
    ...usageColumns(usage),
    whole(loadGenCpu)
  ]
}

const fanOutScenario = (settings: Settings) =>
  Effect.gen(function*() {
    yield* heading(
      4,
      `Fan-out: S Representations subscribers, one Present every ${FANOUT_INTERVAL_MS} ms for ${settings.seconds} s; delay in ms from sending an update until the last subscriber has it (each representation carries every bid so far)`
    )
    const rows: Array<ReadonlyArray<string>> = []
    const failures: Array<string> = []
    for (const requested of settings.subscribers) {
      const outcome = yield* fanOutOutcome(requested, settings.seconds)
      rows.push(fanOutRow(outcome))
      if (outcome.firstFailure !== undefined) failures.push(`${requested} subscribers: ${outcome.firstFailure}`)
    }
    yield* Console.log(table([FANOUT_HEADER, ...rows]))
    yield* Effect.forEach(failures, (failure) => Console.log(`subscriber failure, first of its row: ${failure}`), { discard: true })
  })

// ---------------------------------------------------------------------------------------------
// Scenario 5: memory
// ---------------------------------------------------------------------------------------------

const MEMORY_HEADER = ["moment", "steps sent", "RSS MiB", "RSS vs idle MiB", "heap used MiB"]

const memoryRow = (moment: string, steps: number, sample: Sample, idle: Sample) => [
  moment,
  String(steps),
  mib(sample.rssKib),
  mib(sample.rssKib - idle.rssKib),
  mib(sample.heapUsedKib)
]

const presentSteps = (connection: Connection, counter: Counter, count: number) =>
  Effect.forEach(range(count), () => presentStep(connection, counter)(), { discard: true })

const memoryRows = (steps: ReadonlyArray<number>) =>
  Effect.scoped(Effect.gen(function*() {
    const server = yield* startServer(yield* claimPort())
    const presenter = yield* open(server.port, layerAuthenticationAnonymous)
    const counter = makeCounter()
    yield* presenter.model.present(opened)
    yield* Effect.sleep(IDLE_SETTLE)
    const idle = yield* sampleOnce(server.child)
    const rows: Array<ReadonlyArray<string>> = [memoryRow("idle after start", 0, idle, idle)]
    for (const target of steps) {
      yield* presentSteps(presenter, counter, target - counter.issued())
      rows.push(memoryRow(`right after ${target} steps`, counter.issued(), yield* sampleOnce(server.child), idle))
    }
    yield* Effect.sleep(IDLE_SETTLE)
    rows.push(memoryRow("1 s later, idle", counter.issued(), yield* sampleOnce(server.child), idle))
    return rows
  }))

const memoryScenario = (settings: Settings) =>
  Effect.gen(function*() {
    yield* heading(
      5,
      "Server memory in MiB (RSS and V8 heap in use, no garbage collection forced, so garbage is included) as one client sends bids; the history keeps up to 1000 records and 64 MiB of estimated retained size (HistoryRetainedSize), while the model's bids array grows with every accepted bid"
    )
    const rows = yield* memoryRows(settings.memorySteps)
    yield* Console.log(table([MEMORY_HEADER, ...rows]))
  })

// ---------------------------------------------------------------------------------------------
// Scenario 6: sync
// ---------------------------------------------------------------------------------------------

/** What one row of scenario 6 measured, with a fixed number of bids after the same warm-up. */
interface SyncOutcome {
  /** Bids already in the auction when the timed bids start: the warm-up's, the same in every row. */
  readonly bidsBefore: number
  /** The window of the server the client talks to. */
  readonly run: Measured<ReadonlyArray<number>>
  /** The joiner's usage over the same window; absent when there is no joiner. */
  readonly joinerUsage: Usage | undefined
}

/** Exactly `count` steps one after the other: rows that must compare like with like send the same number, not run for the same time. */
const runFixedSteps = <E>(step: Step<E>, count: number) =>
  Effect.gen(function*() {
    const latencies: Array<number> = []
    for (let done = 0; done < count; done++) {
      const started = performance.now()
      yield* step()
      latencies.push(performance.now() - started)
    }
    return latencies
  })

/** A fresh server without sync and one client: the reference the synced rows are compared with. */
const unsyncedOutcome = (bids: number) =>
  Effect.scoped(Effect.gen(function*() {
    const server = yield* startServer(yield* claimPort())
    const sampler = yield* startSampler(server.child)
    const client = yield* open(server.port, layerAuthenticationAnonymous)
    const counter = makeCounter()
    yield* client.model.present(opened)
    const step = presentStep(client, counter)
    yield* warmUp([step])
    const bidsBefore = counter.issued()
    const run = yield* measure(sampler, runFixedSteps(step, bids))
    return { bidsBefore, run, joinerUsage: undefined } satisfies SyncOutcome
  }))

/** One client of each instance of a synced pair. */
interface SyncClients {
  readonly onHost: Connection
  readonly onJoiner: Connection
}

/** A fresh host with its event log on a port of its own and a fresh joiner of that log; the client that `pick` returns sends the bids. */
const syncedOutcome = (bids: number, pick: (clients: SyncClients) => Connection) =>
  Effect.scoped(Effect.gen(function*() {
    const hostPort = yield* claimPort()
    const logPort = yield* claimPort()
    const joinerPort = yield* claimPort()
    const host = yield* startServer(hostPort, { MUFW_SYNC: "host", MUFW_SYNC_PORT: String(logPort) })
    yield* untilListening(logPort)
    const joiner = yield* startServer(joinerPort, { MUFW_SYNC: `ws://127.0.0.1:${logPort}${EVENT_LOG_PATH}` })
    const hostSampler = yield* startSampler(host.child)
    const joinerSampler = yield* startSampler(joiner.child)
    const onHost = yield* open(host.port, layerAuthenticationAnonymous)
    const onJoiner = yield* open(joiner.port, layerAuthenticationAnonymous)
    const counter = makeCounter()
    yield* onHost.model.present(opened)
    yield* onJoiner.model.representations.pipe(
      Stream.filter((representation) => representation.controlState === "open"),
      Stream.runHead,
      Effect.timeout("15 seconds")
    )
    const step = presentStep(pick({ onHost, onJoiner }), counter)
    yield* warmUp([step])
    const bidsBefore = counter.issued()
    const timed = yield* measure(hostSampler, measure(joinerSampler, runFixedSteps(step, bids)))
    return { bidsBefore, run: { ...timed, value: timed.value.value }, joinerUsage: timed.value.usage } satisfies SyncOutcome
  }))

const SYNC_HEADER = [
  "client talks to",
  "bids already in model",
  "bids timed",
  "steps/s",
  "p50 ms",
  "p95 ms",
  "p99 ms",
  "max ms",
  "p50 vs no sync",
  "host CPU % mean / max",
  "joiner CPU % mean / max",
  "load generator CPU %"
]

const percentCpu = (usage: Usage) => meanMax(usage.cpuMean, usage.cpuMax, whole)

/** For the row without sync, `server` is the only server and there is no joiner. */
const syncRow = (label: string, outcome: SyncOutcome, referenceMedian: number) => {
  const { loadGenCpu, seconds, usage: server, value: latencies } = outcome.run
  const median = summarize(latencies).median
  return [
    label,
    String(outcome.bidsBefore),
    String(latencies.length),
    rate(latencies.length, seconds),
    ...latencyColumns(latencies),
    `${two(median / referenceMedian)}x`,
    percentCpu(server),
    outcome.joinerUsage === undefined ? "n/a" : percentCpu(outcome.joinerUsage),
    whole(loadGenCpu)
  ]
}

const syncScenario = (settings: Settings) =>
  Effect.gen(function*() {
    yield* heading(
      6,
      `Present against a synced host and a joiner of its event log (MUFW_SYNC), one client sending the same ${settings.syncBids} bids one after the other to a fresh process set per row, after the same warm-up: latency in ms per step and its ratio to a server without sync`
    )
    const reference = yield* unsyncedOutcome(settings.syncBids)
    const viaHost = yield* syncedOutcome(settings.syncBids, ({ onHost }) => onHost)
    const viaJoiner = yield* syncedOutcome(settings.syncBids, ({ onJoiner }) => onJoiner)
    const referenceMedian = summarize(reference.run.value).median
    yield* Console.log(table([
      SYNC_HEADER,
      syncRow("a server without MUFW_SYNC", reference, referenceMedian),
      syncRow("the host", viaHost, referenceMedian),
      syncRow("the joiner", viaJoiner, referenceMedian)
    ]))
  })

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

interface Scenario {
  readonly number: number
  readonly run: (settings: Settings) => Effect.Effect<void, unknown>
}

const scenarios: ReadonlyArray<Scenario> = [
  { number: 1, run: presentSequential },
  { number: 2, run: presentConcurrent },
  { number: 3, run: submitScenario },
  { number: 4, run: fanOutScenario },
  { number: 5, run: memoryScenario },
  { number: 6, run: syncScenario }
]

const program = Effect.gen(function*() {
  const settings = yield* Settings
  yield* Console.log(environment(settings))
  const selected: ReadonlyArray<number> = settings.scenarios
  const chosen = scenarios.filter((scenario) => selected.includes(scenario.number))
  yield* Effect.forEach(chosen, (scenario) => scenario.run(settings), { discard: true })
})

NodeRuntime.runMain(program)
