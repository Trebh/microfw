import type { Effect, Stream } from "effect"
import { Context } from "effect"
import type { ActionFailure, AnyDefinition, IntentOf, ProposalOf, RepresentationOf } from "./Definition.ts"
import type { NoSuchStep, StepRecord } from "./Step.ts"

export type IntentOrigin = "user" | "auto"

export interface IntentEnvelope<I> {
  readonly intent: I
  readonly origin: IntentOrigin
}

/** The local queue between intents and the actions drain. */
export interface IntentBusShape<D extends AnyDefinition> {
  dispatch(intent: IntentOf<D>): Effect.Effect<void>
  dispatchAuto(intent: IntentOf<D>): Effect.Effect<void>
  readonly intents: Stream.Stream<IntentEnvelope<IntentOf<D>>>
}

/** Where user intents enter the loop: the local bus, or a server that runs the actions itself. */
export interface IntentPortShape<D extends AnyDefinition> {
  dispatch(intent: IntentOf<D>): Effect.Effect<void>
}

export interface ActionRunnerShape<D extends AnyDefinition> {
  run(intent: IntentOf<D>): Effect.Effect<ProposalOf<D>, ActionFailure>
}

export interface ModelPortShape<D extends AnyDefinition> {
  present(proposal: ProposalOf<D>): Effect.Effect<void>
  /** Emits the current representation first, then every change. */
  readonly representations: Stream.Stream<RepresentationOf<D>>
}

export interface HistoryPortShape<D extends AnyDefinition> {
  /** Emits every existing record first, then live ones. */
  readonly records: Stream.Stream<StepRecord<D>>
  travelTo(seq: number): Effect.Effect<void, NoSuchStep>
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

export interface Ports<D extends AnyDefinition> {
  readonly IntentBus: Context.Service<IntentBus<D>, IntentBusShape<D>>
  readonly IntentPort: Context.Service<IntentPort<D>, IntentPortShape<D>>
  readonly ActionRunner: Context.Service<ActionRunner<D>, ActionRunnerShape<D>>
  readonly ModelPort: Context.Service<ModelPort<D>, ModelPortShape<D>>
  readonly HistoryPort: Context.Service<HistoryPort<D>, HistoryPortShape<D>>
}

/** Service keys of one definition; their ids are prefixed with the definition's name. */
export const makePorts = <D extends AnyDefinition>(def: D): Ports<D> => ({
  IntentBus: Context.Service<IntentBus<D>, IntentBusShape<D>>(`${def.name}/IntentBus`),
  IntentPort: Context.Service<IntentPort<D>, IntentPortShape<D>>(`${def.name}/IntentPort`),
  ActionRunner: Context.Service<ActionRunner<D>, ActionRunnerShape<D>>(`${def.name}/ActionRunner`),
  ModelPort: Context.Service<ModelPort<D>, ModelPortShape<D>>(`${def.name}/ModelPort`),
  HistoryPort: Context.Service<HistoryPort<D>, HistoryPortShape<D>>(`${def.name}/HistoryPort`)
})
