import type { Effect, Stream } from "effect"
import { Context, Schema } from "effect"
import type { ActionFailure, AnyDefinition, IntentOf, ProposalOf, RepresentationOf } from "./Definition.ts"
import type { NoSuchStep, StepRecord } from "./Step.ts"

export type IntentOrigin = "user" | "auto"

/**
 * An intent was not accepted: the port that runs the actions refused its caller (a server that
 * does not accept the session). A business outcome is a proposal; this is a typed failure of the
 * dispatch, which the page can show.
 */
export class DispatchRefused extends Schema.TaggedError<DispatchRefused>()("DispatchRefused", {
  intentTag: Schema.String,
  message: Schema.String
}) {}

export interface IntentEnvelope<I, R = never> {
  readonly intent: I
  readonly origin: IntentOrigin
  /**
   * The per-request services `R` of the fiber that dispatched the intent (empty for an automatic
   * one). The action runs with them, so a server's per-request services (the caller's identity)
   * reach it through the queue.
   */
  readonly context: Context.Context<R>
}

/**
 * The local queue between intents and the actions drain. It also owns the fibers of automatic
 * actions, so the model that emitted their intents can interrupt them.
 */
export interface IntentBusShape<D extends AnyDefinition, R = never> {
  /** Needs the per-request services `R` of its caller: they travel with the intent to its action. */
  dispatch(intent: IntentOf<D>): Effect.Effect<void, never, R>
  dispatchAuto(intent: IntentOf<D>): Effect.Effect<void>
  /** Starts an automatic action on a fiber that `interruptAuto` interrupts. */
  runAuto(action: Effect.Effect<void>): Effect.Effect<void>
  /** Interrupts every automatic action in flight and returns once they have stopped. */
  readonly interruptAuto: Effect.Effect<void>
  readonly intents: Stream.Stream<IntentEnvelope<IntentOf<D>, R>>
}

/**
 * Where user intents enter the loop: the local bus, or a server that runs the actions itself.
 * Fails with `DispatchRefused` when the other side does not accept the caller; needs the
 * per-request services `R` that the actions read.
 */
export interface IntentPortShape<D extends AnyDefinition, R = never> {
  dispatch(intent: IntentOf<D>): Effect.Effect<void, DispatchRefused, R>
}

export interface ActionRunnerShape<D extends AnyDefinition, R = never> {
  run(intent: IntentOf<D>): Effect.Effect<ProposalOf<D>, ActionFailure, R>
}

export interface ModelPortShape<D extends AnyDefinition> {
  present(proposal: ProposalOf<D>): Effect.Effect<void>
  /** Emits the current representation first, then every change. */
  readonly representations: Stream.Stream<RepresentationOf<D>>
}

export interface HistoryPortShape<D extends AnyDefinition> {
  /** Emits every retained record first, then live ones. */
  readonly records: Stream.Stream<StepRecord<D>>
  /** Fails with `NoSuchStep` for a seq that never existed or was evicted by the retention limit. */
  travelTo(seq: number): Effect.Effect<void, NoSuchStep>
  /**
   * Applies each proposal in order, as one `step` record apiece, under one hold of the model so no
   * other proposal falls between them, and runs no `nap`: the loop starts no automatic action, as
   * after `travelTo`. For a recorded history, which already holds the automatic proposals.
   */
  replay(proposals: ReadonlyArray<ProposalOf<D>>): Effect.Effect<void>
}

export interface IntentBus<D extends AnyDefinition> {
  readonly "~mufw/IntentBus": D
}
export interface IntentPort<D extends AnyDefinition> {
  readonly "~mufw/IntentPort": D
}
export interface ActionRunner<D extends AnyDefinition> {
  readonly "~mufw/ActionRunner": D
}
export interface ModelPort<D extends AnyDefinition> {
  readonly "~mufw/ModelPort": D
}
export interface HistoryPort<D extends AnyDefinition> {
  readonly "~mufw/HistoryPort": D
}

/**
 * `R` names the services a caller supplies per call and the actions read (a server's request
 * identity). It is in the type of every effect that carries an intent to an action, so a
 * dispatcher that does not provide it does not compile. A deployment where no service is per
 * call keeps the default `never`.
 */
export interface Ports<D extends AnyDefinition, R = never> {
  readonly IntentBus: Context.Service<IntentBus<D>, IntentBusShape<D, R>>
  readonly IntentPort: Context.Service<IntentPort<D>, IntentPortShape<D, R>>
  readonly ActionRunner: Context.Service<ActionRunner<D>, ActionRunnerShape<D, R>>
  readonly ModelPort: Context.Service<ModelPort<D>, ModelPortShape<D>>
  readonly HistoryPort: Context.Service<HistoryPort<D>, HistoryPortShape<D>>
}

/** Service keys of one definition; their ids are prefixed with the definition's name. */
export const makePorts = <D extends AnyDefinition, R = never>(def: D): Ports<D, R> => ({
  IntentBus: Context.Service<IntentBus<D>, IntentBusShape<D, R>>(`${def.name}/IntentBus`),
  IntentPort: Context.Service<IntentPort<D>, IntentPortShape<D, R>>(`${def.name}/IntentPort`),
  ActionRunner: Context.Service<ActionRunner<D>, ActionRunnerShape<D, R>>(`${def.name}/ActionRunner`),
  ModelPort: Context.Service<ModelPort<D>, ModelPortShape<D>>(`${def.name}/ModelPort`),
  HistoryPort: Context.Service<HistoryPort<D>, HistoryPortShape<D>>(`${def.name}/HistoryPort`)
})
