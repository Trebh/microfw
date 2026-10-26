import { NodeRuntime } from "@effect/platform-node"
import {
  type ActionRunner,
  type AnyDefinition,
  applyProposal,
  AutoActions,
  type HistoryPort,
  type HistoryPortShape,
  HistoryLimit,
  HistoryRetainedSize,
  type IntentBus,
  type IntentOf,
  type IntentPort,
  layerLoopLocal,
  makePorts,
  type ModelOf,
  type ModelPort,
  type ModelPortShape,
  type Ports,
  type ProposalOf,
  type StepRecord
} from "@mufw/core"
import { Config, Console, Deferred, Effect, Layer, Schema, type Scope, Stream } from "effect"
import { arch, cpus, platform, totalmem } from "node:os"
import { layerCreditCheckPermissive } from "../src/adapters/creditCheckPermissive.ts"
import { layerCurrentBidderFixed } from "../src/adapters/currentBidderFixed.ts"
import { Auction, type Proposal as AuctionProposal } from "../src/auction/Auction.ts"
import { Amount, Bidder } from "../src/domain/Values.ts"
import { Counter, CounterPorts } from "./bench/counter.ts"
import { LIST_ROWS, List, ListPorts } from "./bench/list.ts"
import { kib, mib, ms, summarize, table } from "./stats.ts"

/**
 * In-process microbenchmarks of the SAM loop (`@mufw/core`, `AutoActions` false), for three
 * definitions: the bench `Counter` (the least a step can be), the bench `List` (1000 rows: a step
 * that grows with the data) and the example's own `Auction`.
 *
 * Measured, per case: a pilot, then a warm-up of `BENCH_WARMUP_SECONDS`, then the timed operations
 * (`BENCH_OPS`, or as many as take about `BENCH_SECONDS` at the warm-up's rate). Every group of
 * rounds runs on a fresh loop. Each table says what it measures and in what unit:
 *
 * - cases 1-4, per definition: a hand-written reducer (the definition's pure functions called in a
 *   JS loop), `applyProposal`, `ModelPort.present` through the local loop, and `IntentPort.dispatch`
 *   until the step's record has been seen by a subscriber of `HistoryPort.records`;
 * - case 5: K fibers presenting at once; case 6: S subscribers to the representations while
 *   presenting; case 7: schema decode/encode of the values an RPC hop carries; case 8: heap held by
 *   the retained history, for the Counter and the List at `HistoryLimit` and for the Auction after
 *   5000 and 20000 bids with the default `HistoryRetainedSize` and with `Infinity` (count only);
 *   case 9: what an Effect costs on its own.
 *
 * Not measured: transports, rendering, `nap`-driven automatic actions, a real action's I/O, a
 * second process, cold start, any memory but the heap read in case 8.
 *
 * Known biases:
 * - One Node process, warm JIT: a page loads its code cold, so these figures are the floor of what
 *   the loop costs, not a first-interaction time.
 * - Timings are wall-clock `performance.now()` around each operation (or batch); the timer's own
 *   cost (tens of nanoseconds) is inside every figure. Operations that take under a few
 *   microseconds are timed in batches of the `batch` column, and their percentiles are over batch
 *   means, so p95/p99 hide single-operation outliers there. Loop cases are timed one operation at
 *   a time.
 * - Garbage collection runs inside the timed region; it shows up in p99 and max, never removed.
 * - The Auction's `bids` grows with every step, so a loop is capped at 500 bids and the run is
 *   several fresh loops in a row; its figures are for an auction of 0 to 500 bids.
 * - With `AutoActions` false the drain still takes the intents `nap` emits from the queue and
 *   drops them, so that work is part of every Auction step (`nap` never returns an intent for the
 *   Counter and the List).
 * - Presentation is synchronous under the model's permit, so the fibers of case 5 interleave at
 *   operation boundaries and rarely wait on it: the case shows what contention costs when steps do
 *   not suspend, not under suspending steps.
 * - Case 4 includes one subscriber to `HistoryPort.records`, which is how it knows the step has
 *   been applied (`dispatch` returns once the intent is queued).
 * - Case 8 reads the heap after two forced collections, so garbage is excluded and what remains is
 *   what the history keeps alive plus the loop's own state. `HistoryRetainedSize` bounds an
 *   estimate of the retained size (`Footprint.ts`), not the heap: the heap it leaves measures how
 *   close the estimate is. The `Infinity` rows keep `HistoryLimit` records of a model that grows
 *   with every bid.
 */

const UNCAPPED = Number.MAX_SAFE_INTEGER
const PILOT_OPS = 300
const MIN_OPS = 200
const MAX_OPS = 3_000_000
const TIMER_BATCH_US = 20
const MAX_YIELDS = 100_000
const PROBE_TIMEOUT = "5 seconds"
const AUCTION_BIDS = 500
const SCHEMA_BIDS = 50
const FIBERS = [1, 10, 100] as const
const SUBSCRIBERS = [0, 1, 10, 100] as const

const Settings = Config.all({
  ops: Config.Int("BENCH_OPS").pipe(Config.withDefault(0)),
  seconds: Config.Number("BENCH_SECONDS").pipe(Config.withDefault(1.5)),
  warmupSeconds: Config.Number("BENCH_WARMUP_SECONDS").pipe(Config.withDefault(0.25))
})
type Settings = Config.Success<typeof Settings>

class BenchFailure extends Schema.TaggedError<BenchFailure>()("BenchFailure", {
  message: Schema.String
}) {}

// ---------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------

interface Plan {
  readonly ops: number
  /** Operations per timed sample. */
  readonly batch: number
}

interface Measured {
  readonly ops: number
  readonly batch: number
  /** Microseconds per operation, one sample per batch. */
  readonly samplesUs: ReadonlyArray<number>
  readonly totalMs: number
  /** Notifications a subscriber should have received and did not (case 6). */
  readonly shortfall: number
}

/** Runs `plan.ops` operations on a fresh loop (or fresh state) and times them. */
type Run = (plan: Plan) => Effect.Effect<Measured, BenchFailure>

interface Sizing {
  /** Most operations one fresh loop may run. */
  readonly cap: number
  /** A batch lasts at least this long, so the timer's cost stays small beside the operation's. */
  readonly minBatchUs: number
}

interface Case {
  readonly label: string
  readonly sizing: Sizing
  readonly run: Run
}

interface Result {
  readonly label: string
  readonly measured: Measured
}

/** Keeps the result of a timed operation alive, so the engine cannot drop the work. */
const sink: { value: unknown } = { value: undefined }

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0)

const measuredOf = (plan: Plan, batches: number, samplesUs: ReadonlyArray<number>, totalMs: number): Measured => ({
  ops: batches * plan.batch,
  batch: plan.batch,
  samplesUs,
  totalMs,
  shortfall: 0
})

const batchesOf = (plan: Plan) => Math.max(1, Math.floor(plan.ops / plan.batch))

// Wall clock: `Clock` is an epoch clock in milliseconds, too coarse for operations of microseconds.
const timeSync = (op: (index: number) => unknown, plan: Plan): Measured => {
  const batches = batchesOf(plan)
  const samples: Array<number> = []
  const start = performance.now()
  for (let batch = 0; batch < batches; batch++) {
    const batchStart = performance.now()
    for (let step = 0; step < plan.batch; step++) sink.value = op(batch * plan.batch + step)
    samples.push(((performance.now() - batchStart) * 1000) / plan.batch)
  }
  return measuredOf(plan, batches, samples, performance.now() - start)
}

const timeEffect = (op: (index: number) => Effect.Effect<unknown>, plan: Plan) =>
  Effect.gen(function*() {
    const batches = batchesOf(plan)
    const samples: Array<number> = []
    const start = performance.now()
    for (let batch = 0; batch < batches; batch++) {
      const batchStart = performance.now()
      for (let step = 0; step < plan.batch; step++) yield* op(batch * plan.batch + step)
      samples.push(((performance.now() - batchStart) * 1000) / plan.batch)
    }
    return measuredOf(plan, batches, samples, performance.now() - start)
  })

const syncRun = (makeOp: () => (index: number) => unknown): Run => (plan) => Effect.sync(() => timeSync(makeOp(), plan))

const effectRun = (makeOp: () => (index: number) => Effect.Effect<unknown>): Run => (plan) =>
  timeEffect(makeOp(), plan)

const mergeMeasured = (parts: ReadonlyArray<Measured>, batch: number): Measured => ({
  ops: sum(parts.map((part) => part.ops)),
  batch,
  samplesUs: parts.flatMap((part) => part.samplesUs),
  totalMs: sum(parts.map((part) => part.totalMs)),
  shortfall: sum(parts.map((part) => part.shortfall))
})

const perOpUs = (measured: Measured) => (measured.totalMs * 1000) / measured.ops

const opsPerSecond = (measured: Measured) => measured.ops / (measured.totalMs / 1000)

const chunkSizes = (ops: number, cap: number) => {
  const full = Math.floor(ops / cap)
  const rest = ops - full * cap
  return [...Array.from({ length: full }, () => cap), ...(rest > 0 ? [rest] : [])]
}

/** `plan.ops` operations in as many fresh loops as the cap requires. */
const inRounds = (run: Run, plan: Plan, cap: number) =>
  Effect.gen(function*() {
    const parts = yield* Effect.forEach(chunkSizes(plan.ops, cap), (ops) => run({ ops, batch: plan.batch }))
    return mergeMeasured(parts, plan.batch)
  })

const opsFor = (seconds: number, microsecondsPerOp: number) =>
  Math.min(MAX_OPS, Math.max(MIN_OPS, Math.round((seconds * 1_000_000) / microsecondsPerOp)))

const batchFor = (minBatchUs: number, microsecondsPerOp: number) =>
  Math.max(1, Math.ceil(minBatchUs / microsecondsPerOp))

/** Pilot, warm-up sized in time, then the timed operations; the batch and the count come from the warm-up's rate. */
const sampleCase = (settings: Settings, sizing: Sizing, run: Run) =>
  Effect.gen(function*() {
    const pilot = yield* inRounds(run, { ops: PILOT_OPS, batch: 1 }, sizing.cap)
    const batch = batchFor(sizing.minBatchUs, perOpUs(pilot))
    const warmup = yield* inRounds(
      run,
      { ops: opsFor(settings.warmupSeconds, perOpUs(pilot)), batch },
      sizing.cap
    )
    const ops = settings.ops > 0 ? settings.ops : opsFor(settings.seconds, perOpUs(warmup))
    return yield* inRounds(run, { ops, batch }, sizing.cap)
  })

const measureCases = (settings: Settings, cases: ReadonlyArray<Case>) =>
  Effect.forEach(cases, (item) =>
    Effect.map(sampleCase(settings, item.sizing, item.run), (measured): Result => ({
      label: item.label,
      measured
    })))

const yieldUntil = (condition: () => boolean) =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < MAX_YIELDS; attempt++) {
      if (condition()) return true
      yield* Effect.yieldNow
    }
    return condition()
  })

const waitUntil = (condition: () => boolean, message: string) =>
  Effect.flatMap(yieldUntil(condition), (met) => (met ? Effect.void : Effect.fail(new BenchFailure({ message }))))

const cycle = <T>(items: ReadonlyArray<T>, index: number): T => items[index % items.length]!

// ---------------------------------------------------------------------------------------------
// Subjects: the definitions and what a valid run of proposals and intents looks like
// ---------------------------------------------------------------------------------------------

type LoopServices<D extends AnyDefinition> =
  | IntentBus<D>
  | IntentPort<D>
  | ActionRunner<D>
  | ModelPort<D>
  | HistoryPort<D>

interface Subject<D extends AnyDefinition> {
  readonly name: string
  readonly def: D
  readonly ports: Ports<D>
  readonly layer: Layer.Layer<LoopServices<D>>
  /** Presented first on a fresh loop: what makes `proposals` and `intents` valid. */
  readonly prelude: ReadonlyArray<ProposalOf<D>>
  /** Cycled; valid in order on a fresh loop after the prelude, for up to `cap` of them. */
  readonly proposals: ReadonlyArray<ProposalOf<D>>
  readonly intents: ReadonlyArray<IntentOf<D>>
  readonly cap: number
}

const noAutoActions = Layer.succeed(AutoActions, false)

const counterSubject: Subject<typeof Counter> = {
  name: "Counter",
  def: Counter,
  ports: CounterPorts,
  layer: layerLoopLocal(Counter, CounterPorts).pipe(Layer.provide(noAutoActions)),
  prelude: [],
  proposals: [{ _tag: "Inc", by: 1 }],
  intents: [{ _tag: "Inc", by: 1 }],
  cap: UNCAPPED
}

const listSubject: Subject<typeof List> = {
  name: `List (${LIST_ROWS} rows)`,
  def: List,
  ports: ListPorts,
  layer: layerLoopLocal(List, ListPorts).pipe(Layer.provide(noAutoActions)),
  prelude: [],
  proposals: Array.from({ length: LIST_ROWS }, (_, id) => ({ _tag: "Toggle" as const, id })),
  intents: Array.from({ length: LIST_ROWS }, (_, id) => ({ _tag: "Toggle" as const, id })),
  cap: UNCAPPED
}

const opened: AuctionProposal = { _tag: "Opened", at: 1_000 }

/** Update `index` is a bid that is always valid after the opening (the minimum increment is 5). */
const bidNumber = (index: number): AuctionProposal => ({
  _tag: "BidPlaced",
  bidder: Bidder.make(`x${index}x`),
  amount: Amount.make(5 * (index + 1)),
  at: 1_000 + index
})

const bidIntentNumber = (index: number) => ({ _tag: "PlaceBid" as const, amount: Amount.make(5 * (index + 1)) })

const auctionPorts = makePorts(Auction)

const auctionSubject: Subject<typeof Auction> = {
  name: "Auction",
  def: Auction,
  ports: auctionPorts,
  layer: layerLoopLocal(Auction, auctionPorts).pipe(
    Layer.provide(Layer.merge(layerCreditCheckPermissive, layerCurrentBidderFixed(Bidder.make("alice")))),
    Layer.provide(noAutoActions)
  ),
  prelude: [opened],
  proposals: Array.from({ length: AUCTION_BIDS }, (_, index) => bidNumber(index)),
  // The probe of case 4 takes the first intent, so the timed ones start at index 1.
  intents: Array.from({ length: AUCTION_BIDS + 1 }, (_, index) => bidIntentNumber(index)),
  cap: AUCTION_BIDS
}

// ---------------------------------------------------------------------------------------------
// A fresh loop
// ---------------------------------------------------------------------------------------------

interface Loop<D extends AnyDefinition> {
  readonly model: ModelPortShape<D>
  readonly history: HistoryPortShape<D>
  readonly dispatch: (intent: IntentOf<D>) => Effect.Effect<void>
}

const openLoop = <D extends AnyDefinition>(subject: Subject<D>) =>
  Effect.gen(function*() {
    const model = yield* subject.ports.ModelPort
    const history = yield* subject.ports.HistoryPort
    const intents = yield* subject.ports.IntentPort
    yield* Effect.forEach(subject.prelude, (proposal) => model.present(proposal), { discard: true })
    // The local bus cannot refuse a caller, so a `DispatchRefused` is a defect here.
    const dispatch = (intent: IntentOf<D>) => Effect.orDie(intents.dispatch(intent))
    const loop: Loop<D> = { model, history, dispatch }
    return loop
  })

/** Builds the subject's layer, runs `use` on its ports and releases it: no state outlives `use`. */
const inFreshLoop = <D extends AnyDefinition, A, E>(
  subject: Subject<D>,
  use: (loop: Loop<D>) => Effect.Effect<A, E, Scope.Scope>
) =>
  Layer.build(subject.layer).pipe(
    Effect.flatMap((context) => Effect.provideContext(openLoop(subject), context)),
    Effect.flatMap(use),
    Effect.scoped
  )

// ---------------------------------------------------------------------------------------------
// Cases 1-4: one step, four ways
// ---------------------------------------------------------------------------------------------

const modelAfterPrelude = <D extends AnyDefinition>(subject: Subject<D>): ModelOf<D> =>
  subject.prelude.reduce<ModelOf<D>>(
    (model, proposal) => applyProposal(subject.def, model, proposal),
    subject.def.initial
  )

/** What a hand-written reducer does: every acceptor, then every reactor, on a plain variable. */
const foldPlain = <D extends AnyDefinition>(def: D, model: ModelOf<D>, proposal: ProposalOf<D>): ModelOf<D> => {
  let next: ModelOf<D> = model
  for (const accept of def.acceptors) next = accept(next, proposal)
  for (const react of def.reactors) next = react(next)
  return next
}

const plainStep = <D extends AnyDefinition>(subject: Subject<D>) => () => {
  let model = modelAfterPrelude(subject)
  return (index: number) => {
    model = foldPlain(subject.def, model, cycle(subject.proposals, index))
    return subject.def.nap(subject.def.state(model))
  }
}

const applyOnly = <D extends AnyDefinition>(subject: Subject<D>) => () => {
  let model = modelAfterPrelude(subject)
  return (index: number) => {
    model = applyProposal(subject.def, model, cycle(subject.proposals, index))
    return model
  }
}

const applyStateNap = <D extends AnyDefinition>(subject: Subject<D>) => () => {
  let model = modelAfterPrelude(subject)
  return (index: number) => {
    model = applyProposal(subject.def, model, cycle(subject.proposals, index))
    return subject.def.nap(subject.def.state(model))
  }
}

const presentRun = <D extends AnyDefinition>(subject: Subject<D>): Run => (plan) =>
  inFreshLoop(subject, (loop) => timeEffect((index) => loop.model.present(cycle(subject.proposals, index)), plan))

interface Arrival {
  readonly seq: number
  readonly done: Deferred.Deferred<void>
}

/** A subscriber to the records that completes a deferred when the step it waits for has been published. */
const observeRecords = <D extends AnyDefinition>(history: HistoryPortShape<D>, lastExisting: number) =>
  Effect.gen(function*() {
    const state: { seen: number; waiting: Arrival | undefined } = { seen: -1, waiting: undefined }
    const onRecord = (record: StepRecord<D>) =>
      Effect.sync(() => {
        state.seen = record.seq
        const waiting = state.waiting
        if (waiting === undefined || record.seq < waiting.seq) return
        state.waiting = undefined
        Deferred.doneUnsafe(waiting.done, Effect.void)
      })
    yield* Effect.forkScoped(Stream.runForEach(history.records, onRecord))
    yield* waitUntil(() => state.seen >= lastExisting, "the records subscriber never caught up")
    const expectNext = () => {
      const done = Deferred.makeUnsafe<void>()
      state.waiting = { seq: state.seen + 1, done }
      return done
    }
    return { expectNext }
  })

const dispatchRun = <D extends AnyDefinition>(subject: Subject<D>): Run => (plan) =>
  inFreshLoop(subject, (loop) =>
    Effect.gen(function*() {
      const observer = yield* observeRecords(loop.history, subject.prelude.length)
      const op = (index: number) =>
        Effect.suspend(() => {
          const arrival = observer.expectNext()
          return loop.dispatch(cycle(subject.intents, index)).pipe(Effect.andThen(Deferred.await(arrival)))
        })
      const probeFailed = () =>
        Effect.fail(new BenchFailure({ message: `${subject.name}: a dispatched intent produced no record` }))
      yield* op(0).pipe(Effect.timeoutOrElse({ duration: PROBE_TIMEOUT, orElse: probeFailed }))
      return yield* timeEffect((index) => op(index + 1), plan)
    }))

const syncSizing = (subject: { readonly cap: number }): Sizing => ({ cap: subject.cap, minBatchUs: TIMER_BATCH_US })
const loopSizing = (subject: { readonly cap: number }): Sizing => ({ cap: subject.cap, minBatchUs: 0 })

const definitionCases = <D extends AnyDefinition>(subject: Subject<D>): ReadonlyArray<Case> => [
  { label: "1 plain: acceptors, state, nap", sizing: syncSizing(subject), run: syncRun(plainStep(subject)) },
  { label: "2a core: applyProposal", sizing: syncSizing(subject), run: syncRun(applyOnly(subject)) },
  {
    label: "2b core: applyProposal, state, nap",
    sizing: syncSizing(subject),
    run: syncRun(applyStateNap(subject))
  },
  { label: "3 loop: ModelPort.present", sizing: loopSizing(subject), run: presentRun(subject) },
  {
    label: "4 loop: IntentPort.dispatch to its record",
    sizing: loopSizing(subject),
    run: dispatchRun(subject)
  }
]

// ---------------------------------------------------------------------------------------------
// Cases 5 and 6: concurrency and fan-out
// ---------------------------------------------------------------------------------------------

const concurrentRun = <D extends AnyDefinition>(subject: Subject<D>, fibers: number): Run => (plan) =>
  inFreshLoop(subject, (loop) =>
    Effect.gen(function*() {
      const perFiber = Math.max(1, Math.floor(plan.ops / fibers))
      const op = (index: number) => loop.model.present(cycle(subject.proposals, index))
      const start = performance.now()
      const parts = yield* Effect.forEach(
        Array.from({ length: fibers }, (_, fiber) => fiber),
        () => timeEffect(op, { ops: perFiber, batch: 1 }),
        { concurrency: "unbounded" }
      )
      return { ...mergeMeasured(parts, 1), totalMs: performance.now() - start }
    }))

/** Each step is followed by one yield, so the subscribers' fibers run inside the timed operation. */
const fanOutRun = <D extends AnyDefinition>(subject: Subject<D>, subscribers: number): Run => (plan) =>
  inFreshLoop(subject, (loop) =>
    Effect.gen(function*() {
      const delivery = { count: 0 }
      const subscriber = Stream.runForEach(
        loop.model.representations,
        () => Effect.sync(() => void (delivery.count += 1))
      )
      yield* Effect.forEach(Array.from({ length: subscribers }), () => Effect.forkScoped(subscriber), {
        discard: true
      })
      yield* waitUntil(() => delivery.count >= subscribers, "the subscribers never received the first representation")
      const step = (index: number) =>
        loop.model.present(cycle(subject.proposals, index)).pipe(Effect.andThen(Effect.yieldNow))
      const measured = yield* timeEffect(step, plan)
      const expected = subscribers * (measured.ops + 1)
      yield* yieldUntil(() => delivery.count >= expected)
      return { ...measured, shortfall: Math.max(0, expected - delivery.count) }
    }))

// ---------------------------------------------------------------------------------------------
// Case 7: the schema boundary
// ---------------------------------------------------------------------------------------------

interface Artefacts<D extends AnyDefinition> {
  readonly intent: IntentOf<D>
  readonly proposal: ProposalOf<D>
  readonly model: ModelOf<D>
}

/** Decoding the schema's encoded form: what a boundary does with a value it has just received. */
const decoding = <T>(schema: Schema.Codec<T, any>, value: T) => {
  const encoded = Schema.encodeSync(schema)(value)
  const decode = Schema.decodeUnknownSync(schema)
  return () => decode(encoded)
}

const decodingEffect = <T>(schema: Schema.Codec<T, any>, value: T) => {
  const encoded = Schema.encodeSync(schema)(value)
  const decode = Schema.decodeUnknownEffect(schema)
  return () => Effect.orDie(decode(encoded))
}

/** What an RPC hop does: the JSON codec's encode and `JSON.stringify`, and `JSON.parse` and its decode. */
const wire = <T>(schema: Schema.Codec<T, any>, value: T) => {
  const codec = Schema.toCodecJson(schema)
  const text = JSON.stringify(Schema.encodeSync(codec)(value))
  const decode = Schema.decodeUnknownSync(codec)
  return {
    size: text.length,
    encode: () => JSON.stringify(Schema.encodeSync(codec)(value)),
    decode: () => decode(JSON.parse(text))
  }
}

const boundarySizing: Sizing = { cap: UNCAPPED, minBatchUs: TIMER_BATCH_US }

const boundaryCases = <D extends AnyDefinition>(def: D, sample: Artefacts<D>): ReadonlyArray<Case> => {
  const representation = def.state(sample.model)
  const modelWire = wire(def.model, sample.model)
  const representationWire = wire(def.representation, representation)
  const sized = (label: string, op: () => unknown): Case => ({
    label,
    sizing: boundarySizing,
    run: syncRun(() => op)
  })
  return [
    sized("decode intent", decoding(def.intent, sample.intent)),
    {
      label: "decode intent (decodeUnknownEffect)",
      sizing: boundarySizing,
      run: effectRun(() => decodingEffect(def.intent, sample.intent))
    },
    sized("decode proposal", decoding(def.proposal, sample.proposal)),
    sized("decode model", decoding(def.model, sample.model)),
    sized(`model to JSON text (${kib(modelWire.size)} KiB)`, modelWire.encode),
    sized("JSON text to model", modelWire.decode),
    sized(`representation to JSON text (${kib(representationWire.size)} KiB)`, representationWire.encode),
    sized("JSON text to representation", representationWire.decode)
  ]
}

const auctionSampleModel = [opened, ...Array.from({ length: SCHEMA_BIDS }, (_, index) => bidNumber(index))].reduce<
  ModelOf<typeof Auction>
>((model, proposal) => applyProposal(Auction, model, proposal), Auction.initial)

const listSampleModel: ModelOf<typeof List> = {
  rows: List.initial.rows.map((row) => ({ id: row.id, on: row.id % 3 === 0 }))
}

// ---------------------------------------------------------------------------------------------
// Case 8: memory
// ---------------------------------------------------------------------------------------------

const gcFunction: unknown = Reflect.get(globalThis, "gc")
const gcAvailable = typeof gcFunction === "function"

const collectGarbage = () => {
  if (typeof gcFunction === "function") gcFunction()
}

const heapUsed = Effect.sync(() => {
  collectGarbage()
  collectGarbage()
  return process.memoryUsage().heapUsed
})

/** Heap after presenting `steps` more proposals than the loop has seen so far, minus the heap before any. */
const retentionRows = <D extends AnyDefinition>(subject: Subject<D>, limit: number) =>
  inFreshLoop(subject, (loop) =>
    Effect.gen(function*() {
      const before = yield* heapUsed
      const rows: Array<Array<string>> = []
      let presented = 0
      for (const target of [limit, 2 * limit]) {
        const indexes = Array.from({ length: target - presented }, (_, offset) => presented + offset)
        yield* Effect.forEach(indexes, (index) => loop.model.present(cycle(subject.proposals, index)), {
          discard: true
        })
        presented = target
        rows.push(retentionRow(subject.name, { steps: presented, limit, before, after: yield* heapUsed }))
      }
      return rows
    }))

interface Retention {
  readonly steps: number
  readonly limit: number
  readonly before: number
  readonly after: number
}

/** The initial record is in `before`; the loop keeps `limit` records (the initial one included). */
const retentionRow = (name: string, retention: Retention) => {
  const retained = Math.min(retention.steps + 1, Math.max(2, retention.limit))
  const added = retained - 1
  const grown = retention.after - retention.before
  return [
    name,
    String(retention.steps),
    String(retained),
    kib(retention.before),
    kib(retention.after),
    kib(grown),
    String(Math.round(grown / added))
  ]
}

const AUCTION_RETENTION_BIDS = [5000, 20_000] as const

/** The auction's loop with the history's size bound set to `bound`. */
const auctionRetentionSubject = (bound: number): Subject<typeof Auction> => ({
  ...auctionSubject,
  layer: auctionSubject.layer.pipe(Layer.provide(Layer.succeed(HistoryRetainedSize, bound)))
})

const presentBids = (loop: Loop<typeof Auction>, bids: number) =>
  Effect.forEach(
    Array.from({ length: bids }, (_, index) => index),
    (index) => loop.model.present(bidNumber(index)),
    { discard: true }
  )

/** One fresh auction loop given the opening and `bids` bids; the opening is in `before`, as the initial record is. */
const auctionRetentionRow = (bids: number, bound: number) =>
  inFreshLoop(auctionRetentionSubject(bound), (loop) =>
    Effect.gen(function*() {
      const before = yield* heapUsed
      yield* presentBids(loop, bids)
      // The stream replays the retained records and ends at the newest.
      const newestSeq = auctionSubject.prelude.length + bids
      const kept = yield* Stream.runCount(loop.history.records.pipe(Stream.takeUntil((record) => record.seq >= newestSeq)))
      const grown = (yield* heapUsed) - before
      return [
        String(bids),
        Number.isFinite(bound) ? `${mib(bound)} MiB` : String(bound),
        String(kept),
        mib(before),
        mib(before + grown),
        mib(grown),
        kib(grown / kept)
      ]
    }))

/** The heap of one model copied row by row: what a record would cost if rows were not shared. */
const unsharedListCopy = Effect.gen(function*() {
  const before = yield* heapUsed
  const copy = List.initial.rows.map((row) => ({ id: row.id, on: row.on }))
  const after = yield* heapUsed
  return { rows: copy.length, bytes: after - before }
})

// ---------------------------------------------------------------------------------------------
// Case 9: Effect on its own
// ---------------------------------------------------------------------------------------------

const threeYields = () =>
  Effect.gen(function*() {
    const first = yield* Effect.succeed(1)
    const second = yield* Effect.succeed(2)
    const third = yield* Effect.succeed(3)
    return first + second + third
  })

const effectBaselineCases: ReadonlyArray<Case> = [
  {
    label: "plain function call",
    sizing: boundarySizing,
    run: syncRun(() => (index) => index + 1)
  },
  {
    label: "Effect.runSync(Effect.succeed(1))",
    sizing: boundarySizing,
    run: syncRun(() => () => Effect.runSync(Effect.succeed(1)))
  },
  {
    label: "Effect.runSync(Effect.gen, 3 yields)",
    sizing: boundarySizing,
    run: syncRun(() => () => Effect.runSync(threeYields()))
  },
  {
    label: "inside a program: yield* Effect.succeed(1)",
    sizing: boundarySizing,
    run: effectRun(() => () => Effect.succeed(1))
  },
  {
    label: "inside a program: yield* Effect.gen, 3 yields",
    sizing: boundarySizing,
    run: effectRun(() => threeYields)
  }
]

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

interface Unit {
  readonly label: string
  readonly perMicrosecond: number
}

const MICROSECONDS: Unit = { label: "µs", perMicrosecond: 1 }
const NANOSECONDS: Unit = { label: "ns", perMicrosecond: 1000 }

const significant = (value: number) => {
  if (value >= 100) return value.toFixed(1)
  if (value >= 10) return value.toFixed(2)
  return value.toFixed(3)
}

const thousands = (value: number) => Math.round(value).toLocaleString("en-US")

const ratioText = (value: number) => `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}x`

const statsHeader = (unit: Unit) => [
  "case",
  "ops",
  "ops/s",
  `mean ${unit.label}`,
  `median ${unit.label}`,
  `p95 ${unit.label}`,
  `p99 ${unit.label}`,
  "total ms",
  "batch"
]

const statsRow = (result: Result, unit: Unit) => {
  const { measured } = result
  const summary = summarize(measured.samplesUs)
  const scaled = (microseconds: number) => significant(microseconds * unit.perMicrosecond)
  return [
    result.label,
    String(measured.ops),
    thousands(opsPerSecond(measured)),
    scaled(summary.mean),
    scaled(summary.median),
    scaled(summary.p95),
    scaled(summary.p99),
    ms(measured.totalMs),
    String(measured.batch)
  ]
}

const report = (heading: string, rows: ReadonlyArray<ReadonlyArray<string>>) =>
  Console.log(`\n${heading}\n${table(rows)}`)

const costRatio = (measured: Measured, baseline: Measured | undefined) =>
  baseline === undefined ? "" : ratioText(perOpUs(measured) / perOpUs(baseline))

const throughputRatio = (measured: Measured, baseline: Measured | undefined) =>
  baseline === undefined ? "" : ratioText(opsPerSecond(measured) / opsPerSecond(baseline))

/** Statistics rows plus one more column, each row compared with the first. */
const comparedRows = (
  results: ReadonlyArray<Result>,
  unit: Unit,
  columnLabel: string,
  compare: (measured: Measured, baseline: Measured | undefined) => string
) => {
  const baseline = results[0]?.measured
  const rows = results.map((result) => [...statsRow(result, unit), compare(result.measured, baseline)])
  return [[...statsHeader(unit), columnLabel], ...rows]
}

const definitionGroup = <D extends AnyDefinition>(settings: Settings, subject: Subject<D>) =>
  Effect.gen(function*() {
    const results = yield* measureCases(settings, definitionCases(subject))
    yield* report(
      `### ${subject.name}, cases 1-4: one step of the loop, ${MICROSECONDS.label} per step (ratio: cost per step relative to the plain reducer)`,
      comparedRows(results, MICROSECONDS, "vs plain", costRatio)
    )
  })

const concurrencyGroup = (settings: Settings) =>
  Effect.gen(function*() {
    const cases = FIBERS.map((fibers): Case => ({
      label: `${fibers} fiber${fibers === 1 ? "" : "s"} presenting`,
      sizing: loopSizing(counterSubject),
      run: concurrentRun(counterSubject, fibers)
    }))
    const results = yield* measureCases(settings, cases)
    yield* report(
      `### Counter, case 5: K fibers calling ModelPort.present at once, ${MICROSECONDS.label} per call from call to return (ratio: throughput relative to one fiber)`,
      comparedRows(results, MICROSECONDS, "throughput vs 1", throughputRatio)
    )
  })

const fanOutGroup = (settings: Settings) =>
  Effect.gen(function*() {
    const cases = SUBSCRIBERS.map((subscribers): Case => ({
      label: `${subscribers} subscriber${subscribers === 1 ? "" : "s"}`,
      sizing: loopSizing(counterSubject),
      run: fanOutRun(counterSubject, subscribers)
    }))
    const results = yield* measureCases(settings, cases)
    const baseline = results[0]?.measured
    const rows = results.map((result) => [
      ...statsRow(result, MICROSECONDS),
      costRatio(result.measured, baseline),
      String(result.measured.shortfall)
    ])
    yield* report(
      `### Counter, case 6: S subscribers to ModelPort.representations while presenting one step at a time, ${MICROSECONDS.label} per step including one yield for the subscribers to run (ratio: cost per step relative to no subscriber)`,
      [[...statsHeader(MICROSECONDS), "vs 0", "undelivered"], ...rows]
    )
  })

const boundaryGroup = <D extends AnyDefinition>(settings: Settings, name: string, def: D, sample: Artefacts<D>) =>
  Effect.gen(function*() {
    const results = yield* measureCases(settings, boundaryCases(def, sample))
    yield* report(
      `### ${name}, case 7: schema boundary, ${MICROSECONDS.label} per operation (a decode of the schema's encoded form; JSON rows are the codec from \`Schema.toCodecJson\` with \`JSON.stringify\`/\`JSON.parse\`)`,
      [statsHeader(MICROSECONDS), ...results.map((result) => statsRow(result, MICROSECONDS))]
    )
  })

const boundaryGroups = (settings: Settings) =>
  Effect.gen(function*() {
    yield* boundaryGroup(settings, "Counter", Counter, {
      intent: { _tag: "Inc", by: 1 },
      proposal: { _tag: "Inc", by: 1 },
      model: { count: 12_345 }
    })
    yield* boundaryGroup(settings, `List (${LIST_ROWS} rows)`, List, {
      intent: { _tag: "Toggle", id: 5 },
      proposal: { _tag: "Toggle", id: 5 },
      model: listSampleModel
    })
    yield* boundaryGroup(settings, `Auction (opened, ${SCHEMA_BIDS} bids)`, Auction, {
      intent: bidIntentNumber(SCHEMA_BIDS),
      proposal: bidNumber(SCHEMA_BIDS),
      model: auctionSampleModel
    })
  })

const retentionGroup = Effect.gen(function*() {
  if (!gcAvailable) {
    yield* Console.log(
      "\n### Case 8, history memory: skipped. `globalThis.gc` is absent, so the heap cannot be read without garbage; run with `node --expose-gc --import tsx scripts/bench-loop.ts` (`pnpm bench:loop`)."
    )
    return
  }
  const limit = yield* HistoryLimit
  const counterRows = yield* retentionRows(counterSubject, limit)
  const listRows = yield* retentionRows(listSubject, limit)
  const copy = yield* unsharedListCopy
  yield* report(
    `### Case 8, history memory: heap after garbage collection, KiB, and bytes per retained record (HistoryLimit ${limit}; the initial record is in "heap before"; the second row of each definition has evicted the oldest)`,
    [
      ["definition", "steps", "records kept", "heap before KiB", "heap after KiB", "grown KiB", "bytes/record"],
      ...counterRows,
      ...listRows
    ]
  )
  yield* Console.log(
    `Reference: copying the List's ${copy.rows} rows one by one costs ${kib(copy.bytes)} KiB (${Math.round(copy.bytes / copy.rows)} bytes per row). A record whose rows were not shared would cost about that much; the bytes/record above are what the loop keeps, rows shared between records.`
  )
  const retainedSize = yield* HistoryRetainedSize
  const auctionRows: Array<Array<string>> = []
  for (const bids of AUCTION_RETENTION_BIDS) {
    for (const bound of [retainedSize, Number.POSITIVE_INFINITY]) {
      auctionRows.push(yield* auctionRetentionRow(bids, bound))
    }
  }
  yield* report(
    `### Case 8, history memory of a growing model: the Auction after the opening and N bids, heap after garbage collection, MiB (HistoryLimit ${limit}; HistoryRetainedSize ${mib(retainedSize)} MiB; "Infinity" keeps by count only)`,
    [
      ["bids", "HistoryRetainedSize", "records kept", "heap before MiB", "heap after MiB", "grown MiB", "KiB/record"],
      ...auctionRows
    ]
  )
})

const effectBaselineGroup = (settings: Settings) =>
  Effect.gen(function*() {
    const results = yield* measureCases(settings, effectBaselineCases)
    yield* report(
      `### Case 9, Effect on its own: ${NANOSECONDS.label} per operation (ratio: cost relative to a plain function call; the engine may inline that call)`,
      comparedRows(results, NANOSECONDS, "vs call", costRatio)
    )
  })

const environmentLines = (settings: Settings) => {
  const processors = cpus()
  const cpuModel = processors[0]?.model ?? "unknown CPU"
  const memoryGiB = (totalmem() / 2 ** 30).toFixed(1)
  const operations = settings.ops > 0
    ? `${settings.ops} timed operations per case`
    : `timed operations sized for about ${settings.seconds} s per case`
  return [
    `# bench-loop: node ${process.version}, ${platform()} ${arch()}, ${cpuModel}, ${processors.length} CPUs, ${memoryGiB} GiB memory, gc ${gcAvailable ? "exposed" : "not exposed"}`,
    `# ${operations}, ${settings.warmupSeconds} s of warm-up before them, AutoActions false`
  ]
}

const program = Effect.gen(function*() {
  const settings = yield* Settings
  yield* Console.log(environmentLines(settings).join("\n"))
  yield* definitionGroup(settings, counterSubject)
  yield* definitionGroup(settings, listSubject)
  yield* definitionGroup(settings, auctionSubject)
  yield* concurrencyGroup(settings)
  yield* fanOutGroup(settings)
  yield* boundaryGroups(settings)
  yield* retentionGroup
  yield* effectBaselineGroup(settings)
})

NodeRuntime.runMain(program)
