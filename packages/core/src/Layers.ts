import { Clock, Context, Effect, Layer, Option, PubSub, Queue, Ref, Semaphore, Stream, SubscriptionRef } from "effect"
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

/** The local queue, which also serves as the `IntentPort` of a loop that runs its own actions. */
export const layerIntentBus = <D extends AnyDefinition>(_def: D, ports: Ports<D>) =>
  Layer.effectContext(
    Effect.gen(function*() {
      const queue = yield* Queue.unbounded<IntentEnvelope<IntentOf<D>>>()
      const bus: IntentBusShape<D> = {
        dispatch: (intent) => Queue.offer(queue, { intent, origin: "user" }).pipe(Effect.asVoid),
        dispatchAuto: (intent) => Queue.offer(queue, { intent, origin: "auto" }).pipe(Effect.asVoid),
        intents: Stream.fromQueue(queue)
      }
      return Context.make(ports.IntentBus, bus).pipe(Context.add(ports.IntentPort, { dispatch: bus.dispatch }))
    })
  )

/** Mutable state of the local model. Only `ModelStore` methods touch it, always under the permit. */
interface ModelStore<D extends AnyDefinition> {
  readonly model: Ref.Ref<ModelOf<D>>
  readonly representation: SubscriptionRef.SubscriptionRef<RepresentationOf<D>>
  readonly records: Array<StepRecord<D>>
  readonly published: PubSub.PubSub<StepRecord<D>>
}

const makeStore = <D extends AnyDefinition>(def: D) =>
  Effect.gen(function*() {
    const store: ModelStore<D> = {
      model: yield* Ref.make<ModelOf<D>>(def.initial),
      representation: yield* SubscriptionRef.make<RepresentationOf<D>>(def.state(def.initial)),
      records: [],
      published: yield* PubSub.unbounded<StepRecord<D>>()
    }
    return store
  })

interface Transition<D extends AnyDefinition> {
  readonly kind: StepKind
  readonly proposal: Option.Option<ProposalOf<D>>
  readonly model: ModelOf<D>
  readonly representation: RepresentationOf<D>
}

const commit = <D extends AnyDefinition>(store: ModelStore<D>, transition: Transition<D>) =>
  Effect.gen(function*() {
    const at = yield* Clock.currentTimeMillis
    const record: StepRecord<D> = { seq: store.records.length, at, ...transition }
    yield* Ref.set(store.model, transition.model)
    yield* SubscriptionRef.set(store.representation, transition.representation)
    store.records.push(record)
    yield* PubSub.publish(store.published, record)
  })

/** Replays the records present at subscription time, then follows live ones without gaps or duplicates. */
const recordsOf = <D extends AnyDefinition>(store: ModelStore<D>): Stream.Stream<StepRecord<D>> =>
  Stream.unwrap(
    Effect.gen(function*() {
      const live = yield* PubSub.subscribe(store.published)
      const existing = store.records.slice()
      const lastExisting = existing.length - 1
      const fresh = Stream.fromSubscription(live).pipe(Stream.filter((record) => record.seq > lastExisting))
      return Stream.concat(Stream.fromIterable(existing), fresh)
    })
  )

const makeModelPort = <D extends AnyDefinition>(
  def: D,
  store: ModelStore<D>,
  bus: IntentBusShape<D>
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
      const target = store.records[seq]
      if (target === undefined) return yield* new NoSuchStep({ seq })
      const { model, representation } = target
      yield* commit(store, { kind: "travel", proposal: Option.none(), model, representation })
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
export const layerModelLocal = <D extends AnyDefinition>(def: D, ports: Ports<D>) =>
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

/** Runs `def.actions` in-process with the services the actions need. */
export const layerActionRunnerLocal = <D extends AnyDefinition>(def: D, ports: Ports<D>) =>
  Layer.effect(
    ports.ActionRunner,
    Effect.gen(function*() {
      const context = yield* Effect.context<ServicesOf<D>>()
      const actions: Record<string, (intent: IntentOf<D>) => Effect.Effect<ProposalOf<D>, any, ServicesOf<D>>> =
        def.actions
      return {
        run: (intent: IntentOf<D>) => Effect.provideContext(Effect.suspend(() => actions[intent._tag]!(intent)), context)
      }
    })
  )

/**
 * Consumes intents, runs them and presents the proposals. An automatic intent whose tag has an
 * action still running is skipped, so a `nap` loop cannot multiply; user intents are never deduped.
 * The tag is released once the action has its proposal, before presenting it: the `nap` of that
 * very step must be able to start the next round.
 */
export const layerActionsDrain = <D extends AnyDefinition>(_def: D, ports: Ports<D>) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const bus = yield* ports.IntentBus
      const runner = yield* ports.ActionRunner
      const model = yield* ports.ModelPort
      const autoActions = yield* AutoActions
      const inFlight = new Set<string>()
      const present = (action: Effect.Effect<ProposalOf<D>, ActionFailure>) =>
        action.pipe(
          Effect.flatMap((proposal) => model.present(proposal)),
          Effect.catchTag("ActionFailure", (failure) => Effect.logWarning("action failed", failure))
        )
      const runAuto = (tag: string, intent: IntentOf<D>) =>
        Effect.suspend(() => {
          if (!autoActions) return Effect.logDebug("auto action dropped", tag)
          if (inFlight.has(tag)) return Effect.logDebug("auto action already in flight", tag)
          inFlight.add(tag)
          const action = runner.run(intent).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(tag))))
          return Effect.forkScoped(present(action))
        })
      const handle = (envelope: IntentEnvelope<IntentOf<D>>) =>
        envelope.origin === "auto"
          ? runAuto(envelope.intent._tag, envelope.intent)
          : Effect.forkScoped(present(runner.run(envelope.intent)))
      yield* Effect.forkScoped(Stream.runForEach(bus.intents, handle))
    })
  )

/** Everything in-process: intent bus, actions drain, local model and local action runner. */
export const layerLoopLocal = <D extends AnyDefinition>(def: D, ports: Ports<D>) =>
  layerActionsDrain(def, ports).pipe(
    Layer.provideMerge(Layer.merge(layerModelLocal(def, ports), layerActionRunnerLocal(def, ports))),
    Layer.provideMerge(layerIntentBus(def, ports))
  )
