import {
  Cause,
  Clock,
  Context,
  Effect,
  FiberSet,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Semaphore,
  Stream,
  SubscriptionRef
} from "effect"
import {
  type ActionFailure,
  type AnyDefinition,
  intentKeyOf,
  type IntentOf,
  type ModelOf,
  type ProposalOf,
  type RepresentationOf,
  type ServicesOf
} from "./Definition.ts"
import type { HistoryPortShape, IntentBusShape, IntentEnvelope, ModelPortShape, Ports } from "./Ports.ts"
import { applyProposal, NoSuchStep, type StepKind, type StepRecord } from "./Step.ts"

/**
 * When `false`, intents emitted by `nap` are dropped; user intents still run. In a synced loop
 * (`layerLoopSynced`) `true` means the instance takes part in the lease that owns automatic
 * actions, not that it runs them: only the holder does.
 */
export const AutoActions = Context.Reference<boolean>("@mufw/core/AutoActions", {
  defaultValue: () => true
})

/**
 * Whether this instance may run an automatic intent right now, asked each time one is about to
 * start. A loop that shares automatic actions among instances provides it (`layerLoopSynced`: the
 * instance that holds the lease); without it `AutoActions` alone decides. An intent is dropped
 * unless both say yes.
 */
export class AutoActionsGate extends Context.Service<AutoActionsGate, {
  readonly open: Effect.Effect<boolean>
}>()("@mufw/core/AutoActionsGate") {}

/**
 * How many records `layerModelLocal` keeps, the initial record (seq 0) included. Seq 0 is never
 * evicted, so a consumer can always reset with `travelTo(0)`; after it the oldest records go
 * first and `travelTo` them fails with `NoSuchStep`. Seqs are never reused. A limit below 2
 * keeps the initial record and the newest one.
 */
export const HistoryLimit = Context.Reference<number>("@mufw/core/HistoryLimit", {
  defaultValue: () => 1000
})

/**
 * How many records a subscriber to `records` can lag behind before the loop stops holding them for
 * it: the live records are published through a window of this size, which a subscriber that
 * stops reading can never grow. A subscriber that falls out of the window reads what it missed
 * from the retained records (`HistoryLimit`) when it resumes, so a backlog below the limit loses
 * nothing the history still holds. A backlog below 1 is 1.
 */
export const HistoryBacklog = Context.Reference<number>("@mufw/core/HistoryBacklog", {
  defaultValue: () => 64
})

/** The local queue, which also serves as the `IntentPort` of a loop that runs its own actions. */
export const layerIntentBus = <D extends AnyDefinition, R = never>(_def: D, ports: Ports<D, R>) =>
  Layer.effectContext(
    Effect.gen(function*() {
      const queue = yield* Queue.unbounded<IntentEnvelope<IntentOf<D>, R>>()
      const autoFibers = yield* FiberSet.make<void>()
      const bus: IntentBusShape<D, R> = {
        dispatch: (intent) =>
          Effect.flatMap(Effect.context<R>(), (context) => Queue.offer(queue, { intent, origin: "user", context })).pipe(
            Effect.asVoid
          ),
        dispatchAuto: (intent) =>
          Queue.offer(queue, { intent, origin: "auto", context: Context.empty() as Context.Context<R> }).pipe(
            Effect.asVoid
          ),
        runAuto: (action) => FiberSet.run(autoFibers, action).pipe(Effect.asVoid),
        interruptAuto: FiberSet.clear(autoFibers),
        intents: Stream.fromQueue(queue)
      }
      return Context.make(ports.IntentBus, bus).pipe(Context.add(ports.IntentPort, { dispatch: bus.dispatch }))
    })
  )

/** Mutable state of the local model. Only `ModelStore` methods touch it, always under the permit. */
interface ModelStore<D extends AnyDefinition> {
  readonly model: Ref.Ref<ModelOf<D>>
  readonly representation: SubscriptionRef.SubscriptionRef<RepresentationOf<D>>
  /** Oldest first: the initial record, then the retained window, whose seqs are consecutive. */
  readonly records: Array<StepRecord<D>>
  readonly retention: number
  readonly published: PubSub.PubSub<StepRecord<D>>
}

const makeStore = <D extends AnyDefinition>(def: D, initial: ModelOf<D>) =>
  Effect.gen(function*() {
    const limit = yield* HistoryLimit
    const backlog = yield* HistoryBacklog
    const store: ModelStore<D> = {
      model: yield* Ref.make<ModelOf<D>>(initial),
      representation: yield* SubscriptionRef.make<RepresentationOf<D>>(def.state(initial)),
      records: [],
      retention: Math.max(2, limit),
      published: yield* PubSub.sliding<StepRecord<D>>(Math.max(1, backlog))
    }
    return store
  })

interface Transition<D extends AnyDefinition> {
  readonly kind: StepKind
  readonly proposal: Option.Option<ProposalOf<D>>
  readonly model: ModelOf<D>
  readonly representation: RepresentationOf<D>
  readonly travelledTo?: number
}

/** The retained record with this seq; `undefined` for a seq that never existed or was evicted. */
const recordAt = <D extends AnyDefinition>(store: ModelStore<D>, seq: number) => {
  const [initial, oldest] = store.records
  if (initial === undefined || seq === initial.seq) return initial
  if (oldest === undefined || seq < oldest.seq) return undefined
  return store.records[1 + seq - oldest.seq]
}

const evictOldest = <D extends AnyDefinition>(store: ModelStore<D>) => {
  const excess = store.records.length - store.retention
  if (excess > 0) store.records.splice(1, excess)
}

const commit = <D extends AnyDefinition>(store: ModelStore<D>, transition: Transition<D>) =>
  Effect.gen(function*() {
    const at = yield* Clock.currentTimeMillis
    const lastSeq = store.records.at(-1)?.seq ?? -1
    const record: StepRecord<D> = { seq: lastSeq + 1, at, ...transition }
    yield* Ref.set(store.model, transition.model)
    yield* SubscriptionRef.set(store.representation, transition.representation)
    store.records.push(record)
    evictOldest(store)
    yield* PubSub.publish(store.published, record)
  })

/**
 * Passes the live records through in seq order. A record that follows a gap, because the subscriber
 * lagged past the published window, is preceded by the retained records the gap covered; the ones
 * already evicted are skipped, as a new subscriber never sees them.
 */
const closingGaps = <D extends AnyDefinition>(store: ModelStore<D>, firstExpected: number) => {
  const next = (expected: number, record: StepRecord<D>): readonly [number, ReadonlyArray<StepRecord<D>>] => {
    if (record.seq === expected) return [record.seq + 1, [record]]
    const missed = store.records.filter((retained) => retained.seq >= expected && retained.seq < record.seq)
    return [record.seq + 1, [...missed, record]]
  }
  return Stream.mapAccum(() => firstExpected, next)
}

/** Replays the records retained at subscription time, then follows live ones without gaps or duplicates. */
const recordsOf = <D extends AnyDefinition>(store: ModelStore<D>): Stream.Stream<StepRecord<D>> =>
  Stream.unwrap(
    Effect.gen(function*() {
      const live = yield* PubSub.subscribe(store.published)
      const existing = store.records.slice()
      const lastExisting = existing.at(-1)?.seq ?? -1
      const fresh = Stream.fromSubscription(live).pipe(
        Stream.filter((record) => record.seq > lastExisting),
        closingGaps(store, lastExisting + 1)
      )
      return Stream.concat(Stream.fromIterable(existing), fresh)
    })
  )

const makeModelPort = <D extends AnyDefinition>(
  def: D,
  store: ModelStore<D>,
  bus: Pick<IntentBusShape<D>, "dispatchAuto" | "interruptAuto">
) => {
  const permit = Semaphore.makeUnsafe(1)
  const runNap = (representation: RepresentationOf<D>) =>
    Option.match(def.nap(representation), {
      onNone: () => Effect.void,
      onSome: (intent) => bus.dispatchAuto(intent)
    })
  const napAgain = permit.withPermits(1)(Effect.flatMap(SubscriptionRef.get(store.representation), runNap))
  const applyStep = (proposal: ProposalOf<D>) =>
    Effect.gen(function*() {
      const model = applyProposal(def, yield* Ref.get(store.model), proposal)
      const representation = def.state(model)
      yield* commit(store, { kind: "step", proposal: Option.some(proposal), model, representation })
      return representation
    })
  const travel = (seq: number) =>
    Effect.gen(function*() {
      const target = recordAt(store, seq)
      if (target === undefined) return yield* new NoSuchStep({ seq })
      const { model, representation } = target
      yield* bus.interruptAuto
      yield* commit(store, { kind: "travel", proposal: Option.none(), model, representation, travelledTo: seq })
    })
  const port: ModelPortShape<D> & HistoryPortShape<D> = {
    present: (proposal) => permit.withPermits(1)(Effect.flatMap(applyStep(proposal), runNap)),
    representations: SubscriptionRef.changes(store.representation),
    records: recordsOf(store),
    travelTo: (seq) => permit.withPermits(1)(travel(seq)),
    replay: (proposals) => permit.withPermits(1)(Effect.forEach(proposals, applyStep, { discard: true }))
  }
  return { port, runNap, napAgain }
}

/** Starts a local loop from a model other than `def.initial`, already decoded by the caller. */
export interface LocalModelOptions<D extends AnyDefinition> {
  readonly initial?: ModelOf<D>
}

/**
 * The local model without a layer around it: both ports in one object, and a read of the model
 * the last committed record holds. Seq 0 (`init`) carries `options.initial` when given, else
 * `def.initial`. `layerModelLocal` is this, provided under the ports' keys; a loop that applies
 * proposals itself and must know the model after each one (`layerLoopSynced`) uses it directly.
 */
export const makeLocalModel = <D extends AnyDefinition>(
  def: D,
  bus: Pick<IntentBusShape<D>, "dispatchAuto" | "interruptAuto">,
  options?: LocalModelOptions<D>
) =>
  Effect.gen(function*() {
    const initial = options?.initial ?? def.initial
    const store = yield* makeStore(def, initial)
    const { port, runNap, napAgain } = makeModelPort(def, store, bus)
    const representation = def.state(initial)
    yield* commit(store, { kind: "init", proposal: Option.none(), model: initial, representation })
    yield* runNap(representation)
    return { port, model: Ref.get(store.model), napAgain }
  })

/**
 * In-process model: one state object provides both `ModelPort` and `HistoryPort`. Requires
 * `IntentBus`. Seq 0 (`init`) carries `options.initial` when given, else `def.initial`, so
 * `travelTo(0)` returns to it.
 */
export const layerModelLocal = <D extends AnyDefinition, R = never>(
  def: D,
  ports: Ports<D, R>,
  options?: LocalModelOptions<D>
) =>
  Layer.effectContext(
    Effect.gen(function*() {
      const bus = yield* ports.IntentBus
      const { port } = yield* makeLocalModel(def, bus, options)
      return Context.make(ports.ModelPort, port).pipe(Context.add(ports.HistoryPort, port))
    })
  )

/**
 * Runs `def.actions` in-process. The services the layer requires are captured when it is built;
 * `R`, the per-request services of `ports`, are not: `run` needs them, and they come from the fiber
 * that calls it (an RPC middleware's identity, for one), so a caller that lacks one does not
 * compile. A service captured at build time wins over one of the same key in the caller's fiber.
 */
export const layerActionRunnerLocal = <D extends AnyDefinition, R = never>(def: D, ports: Ports<D, R>) =>
  Layer.effect(
    ports.ActionRunner,
    Effect.gen(function*() {
      type Built = Exclude<ServicesOf<D>, R>
      const context = yield* Effect.context<Built>()
      const actions: Record<string, (intent: IntentOf<D>) => Effect.Effect<ProposalOf<D>, any, Built>> = def.actions
      return {
        // `Exclude<ServicesOf<D>, Built>` is `R`; TypeScript cannot simplify it over a generic `D`.
        run: (intent: IntentOf<D>) =>
          Effect.provideContext(Effect.suspend(() => actions[intent._tag]!(intent)), context) as Effect.Effect<
            ProposalOf<D>,
            ActionFailure,
            R
          >
      }
    })
  )

/**
 * Consumes intents, runs them and presents the proposals. An automatic intent whose key
 * (`definition.intentKey`, default its tag) has an action still running is skipped, so a `nap`
 * loop cannot multiply; user intents are never deduped.
 * The key is released once the action has its proposal, before presenting it: the `nap` of that
 * very step must be able to start the next round.
 *
 * A user intent's action runs with the services of the fiber that dispatched it, so a request's
 * identity survives the queue; an automatic one runs with none, so an action that needs a
 * per-request service dies when `nap` triggers it.
 *
 * An automatic intent is dropped when `AutoActions` is false or when the `AutoActionsGate` in
 * context, if any, is closed at the moment the intent is taken from the queue.
 *
 * Automatic actions run on the bus's fibers, which `travelTo` interrupts. A defect in any action
 * or in its `present` is logged with the intent tag and the cause; the drain keeps running.
 */
export const layerActionsDrain = <D extends AnyDefinition, R = never>(def: D, ports: Ports<D, R>) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const bus = yield* ports.IntentBus
      const runner = yield* ports.ActionRunner
      const model = yield* ports.ModelPort
      const autoActions = yield* AutoActions
      const gate = yield* Effect.serviceOption(AutoActionsGate)
      const mayRunAuto = Option.match(gate, {
        onNone: () => Effect.succeed(autoActions),
        onSome: ({ open }) => Effect.map(open, (isOpen) => autoActions && isOpen)
      })
      const inFlight = new Set<string>()
      const present = (tag: string, action: Effect.Effect<ProposalOf<D>, ActionFailure>) =>
        action.pipe(
          Effect.flatMap((proposal) => model.present(proposal)),
          Effect.catchTag("ActionFailure", (failure) => Effect.logWarning("action failed", failure)),
          Effect.catchDefect((defect) => Effect.logError("action died", tag, Cause.die(defect)))
        )
      const startAuto = (envelope: IntentEnvelope<IntentOf<D>, R>) =>
        Effect.suspend(() => {
          const tag = envelope.intent._tag
          const key = intentKeyOf(def, envelope.intent)
          if (inFlight.has(key)) return Effect.logDebug("auto action already in flight", tag)
          inFlight.add(key)
          const action = Effect.provideContext(runner.run(envelope.intent), envelope.context).pipe(
            Effect.ensuring(Effect.sync(() => inFlight.delete(key)))
          )
          return bus.runAuto(present(tag, action))
        })
      const runAuto = (envelope: IntentEnvelope<IntentOf<D>, R>) =>
        Effect.flatMap(mayRunAuto, (mayRun) =>
          mayRun ? startAuto(envelope) : Effect.logDebug("auto action dropped", envelope.intent._tag))
      const handle = (envelope: IntentEnvelope<IntentOf<D>, R>) =>
        envelope.origin === "auto"
          ? runAuto(envelope)
          : Effect.forkScoped(
            present(envelope.intent._tag, Effect.provideContext(runner.run(envelope.intent), envelope.context))
          )
      yield* Effect.forkScoped(Stream.runForEach(bus.intents, handle))
    })
  )

/** Everything in-process: intent bus, actions drain, local model and local action runner. */
export const layerLoopLocal = <D extends AnyDefinition, R = never>(
  def: D,
  ports: Ports<D, R>,
  options?: LocalModelOptions<D>
) =>
  layerActionsDrain(def, ports).pipe(
    Layer.provideMerge(Layer.merge(layerModelLocal(def, ports, options), layerActionRunnerLocal(def, ports))),
    Layer.provideMerge(layerIntentBus(def, ports))
  )
