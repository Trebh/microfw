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
import type {
  ActionFailure,
  AnyDefinition,
  IntentOf,
  ModelOf,
  ProposalOf,
  RepresentationOf,
  ServicesOf
} from "./Definition.ts"
import type { HistoryPortShape, IntentBusShape, IntentEnvelope, ModelPortShape, Ports } from "./Ports.ts"
import { applyProposal, NoSuchStep, type StepKind, type StepRecord } from "./Step.ts"

/** When `false`, intents emitted by `nap` are dropped; user intents still run. */
export const AutoActions = Context.Reference<boolean>("@mufw/core/AutoActions", {
  defaultValue: () => true
})

/**
 * How many records `layerModelLocal` keeps, the initial record (seq 0) included. Seq 0 is never
 * evicted, so a consumer can always reset with `travelTo(0)`; after it the oldest records go
 * first and `travelTo` them fails with `NoSuchStep`. Seqs are never reused. A limit below 2
 * keeps the initial record and the newest one.
 */
export const HistoryLimit = Context.Reference<number>("@mufw/core/HistoryLimit", {
  defaultValue: () => 1000
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

const makeStore = <D extends AnyDefinition>(def: D) =>
  Effect.gen(function*() {
    const limit = yield* HistoryLimit
    const store: ModelStore<D> = {
      model: yield* Ref.make<ModelOf<D>>(def.initial),
      representation: yield* SubscriptionRef.make<RepresentationOf<D>>(def.state(def.initial)),
      records: [],
      retention: Math.max(2, limit),
      published: yield* PubSub.unbounded<StepRecord<D>>()
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

/** Replays the records retained at subscription time, then follows live ones without gaps or duplicates. */
const recordsOf = <D extends AnyDefinition>(store: ModelStore<D>): Stream.Stream<StepRecord<D>> =>
  Stream.unwrap(
    Effect.gen(function*() {
      const live = yield* PubSub.subscribe(store.published)
      const existing = store.records.slice()
      const lastExisting = existing.at(-1)?.seq ?? -1
      const fresh = Stream.fromSubscription(live).pipe(Stream.filter((record) => record.seq > lastExisting))
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
  const step = (proposal: ProposalOf<D>) =>
    Effect.gen(function*() {
      const model = applyProposal(def, yield* Ref.get(store.model), proposal)
      const representation = def.state(model)
      yield* commit(store, { kind: "step", proposal: Option.some(proposal), model, representation })
      yield* runNap(representation)
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
    present: (proposal) => permit.withPermits(1)(step(proposal)),
    representations: SubscriptionRef.changes(store.representation),
    records: recordsOf(store),
    travelTo: (seq) => permit.withPermits(1)(travel(seq))
  }
  return { port, runNap }
}

/** In-process model: one state object provides both `ModelPort` and `HistoryPort`. Requires `IntentBus`. */
export const layerModelLocal = <D extends AnyDefinition, R = never>(def: D, ports: Ports<D, R>) =>
  Layer.effectContext(
    Effect.gen(function*() {
      const bus = yield* ports.IntentBus
      const store = yield* makeStore(def)
      const { port, runNap } = makeModelPort(def, store, bus)
      const representation = def.state(def.initial)
      yield* commit(store, { kind: "init", proposal: Option.none(), model: def.initial, representation })
      yield* runNap(representation)
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
 * Consumes intents, runs them and presents the proposals. An automatic intent whose tag has an
 * action still running is skipped, so a `nap` loop cannot multiply; user intents are never deduped.
 * The tag is released once the action has its proposal, before presenting it: the `nap` of that
 * very step must be able to start the next round.
 *
 * A user intent's action runs with the services of the fiber that dispatched it, so a request's
 * identity survives the queue; an automatic one runs with none, so an action that needs a
 * per-request service dies when `nap` triggers it.
 *
 * Automatic actions run on the bus's fibers, which `travelTo` interrupts. A defect in any action
 * or in its `present` is logged with the intent tag and the cause; the drain keeps running.
 */
export const layerActionsDrain = <D extends AnyDefinition, R = never>(_def: D, ports: Ports<D, R>) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const bus = yield* ports.IntentBus
      const runner = yield* ports.ActionRunner
      const model = yield* ports.ModelPort
      const autoActions = yield* AutoActions
      const inFlight = new Set<string>()
      const present = (tag: string, action: Effect.Effect<ProposalOf<D>, ActionFailure>) =>
        action.pipe(
          Effect.flatMap((proposal) => model.present(proposal)),
          Effect.catchTag("ActionFailure", (failure) => Effect.logWarning("action failed", failure)),
          Effect.catchDefect((defect) => Effect.logError("action died", tag, Cause.die(defect)))
        )
      const runAuto = (envelope: IntentEnvelope<IntentOf<D>, R>) =>
        Effect.suspend(() => {
          const tag = envelope.intent._tag
          if (!autoActions) return Effect.logDebug("auto action dropped", tag)
          if (inFlight.has(tag)) return Effect.logDebug("auto action already in flight", tag)
          inFlight.add(tag)
          const action = Effect.provideContext(runner.run(envelope.intent), envelope.context).pipe(
            Effect.ensuring(Effect.sync(() => inFlight.delete(tag)))
          )
          return bus.runAuto(present(tag, action))
        })
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
export const layerLoopLocal = <D extends AnyDefinition, R = never>(def: D, ports: Ports<D, R>) =>
  layerActionsDrain(def, ports).pipe(
    Layer.provideMerge(Layer.merge(layerModelLocal(def, ports), layerActionRunnerLocal(def, ports))),
    Layer.provideMerge(layerIntentBus(def, ports))
  )
