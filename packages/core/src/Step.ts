import type { Option } from "effect"
import { Schema } from "effect"
import type { AnyDefinition, ModelOf, ProposalOf, RepresentationOf } from "./Definition.ts"

/** Folds the acceptors over the proposal, then the reactors over the result. */
export const applyProposal = <D extends AnyDefinition>(
  def: D,
  model: ModelOf<D>,
  proposal: ProposalOf<D>
): ModelOf<D> => {
  const accepted = def.acceptors.reduce((m: ModelOf<D>, accept) => accept(m, proposal), model)
  return def.reactors.reduce((m: ModelOf<D>, react) => react(m), accepted)
}

/** `restore` is the model of an event log's snapshot replacing the instance's own. */
export type StepKind = "init" | "step" | "travel" | "restore"

export interface StepRecord<D extends AnyDefinition> {
  readonly seq: number
  readonly at: number
  readonly kind: StepKind
  readonly proposal: Option.Option<ProposalOf<D>>
  readonly model: ModelOf<D>
  readonly representation: RepresentationOf<D>
  /** The seq whose model and representation a `travel` record restored; absent on other records. */
  readonly travelledTo?: number
}

export const stepRecordSchema = <D extends AnyDefinition>(def: D): Schema.Codec<StepRecord<D>, unknown> =>
  Schema.Struct({
    seq: Schema.Int,
    at: Schema.Number,
    kind: Schema.Literals(["init", "step", "travel", "restore"]),
    proposal: Schema.Option(def.proposal),
    model: def.model,
    representation: def.representation,
    travelledTo: Schema.optional(Schema.Int)
  })

export class NoSuchStep extends Schema.TaggedError<NoSuchStep>()("NoSuchStep", {
  seq: Schema.Int
}) {}
