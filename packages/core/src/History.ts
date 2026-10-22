import { Effect, Equal, Option, Result, Schema, Stream } from "effect"
import type { AnyDefinition, ModelOf, ProposalOf } from "./Definition.ts"
import type { HistoryPort, ModelPort, Ports } from "./Ports.ts"
import { applyProposal, NoSuchStep, type StepRecord, stepRecordSchema } from "./Step.ts"

/** A history is an array of step records; the schema every export and import goes through. */
export const historySchema = <D extends AnyDefinition>(def: D): Schema.Codec<ReadonlyArray<StepRecord<D>>, unknown> =>
  Schema.Array(stepRecordSchema(def))

/** The JSON text of a history: `Option` proposals and optional fields take their canonical JSON form. */
const historyJson = <D extends AnyDefinition>(def: D) =>
  Schema.fromJsonString(Schema.toCodecJson(historySchema(def)))

/** Encodes a history as JSON text; the inverse of `decodeHistoryJson`. */
export const encodeHistoryJson = <D extends AnyDefinition>(def: D) => {
  const encode = Schema.encodeEffect(historyJson(def))
  return (records: ReadonlyArray<StepRecord<D>>): Effect.Effect<string, Schema.SchemaError> => encode(records)
}

/**
 * Decodes untrusted JSON text into a history, once: a record that does not match the definition's
 * model, proposal and representation schemas fails with a `SchemaError`.
 */
export const decodeHistoryJson = <D extends AnyDefinition>(def: D) => {
  const decode = Schema.decodeEffect(historyJson(def))
  return (json: string): Effect.Effect<ReadonlyArray<StepRecord<D>>, Schema.SchemaError> => decode(json)
}

interface RecordedStep<D extends AnyDefinition> {
  readonly record: StepRecord<D>
  readonly proposal: ProposalOf<D>
}

const recordAt = <D extends AnyDefinition>(
  records: ReadonlyArray<StepRecord<D>>,
  seq: number
): Result.Result<StepRecord<D>, NoSuchStep> => {
  const found = records.find((record) => record.seq === seq)
  return found === undefined ? Result.fail(new NoSuchStep({ seq })) : Result.succeed(found)
}

/** The `step` records after `seq`, in history order; `init` and `travel` records carry no proposal to replay. */
const stepsAfter = <D extends AnyDefinition>(
  records: ReadonlyArray<StepRecord<D>>,
  seq: number
): ReadonlyArray<RecordedStep<D>> =>
  records.flatMap((record): ReadonlyArray<RecordedStep<D>> => {
    if (record.seq <= seq || record.kind !== "step") return []
    return Option.toArray(Option.map(record.proposal, (proposal) => ({ record, proposal })))
  })

const recompute = <D extends AnyDefinition>(
  def: D,
  from: ModelOf<D>,
  steps: ReadonlyArray<RecordedStep<D>>
): ReadonlyArray<StepRecord<D>> => {
  const replayed: Array<StepRecord<D>> = []
  let model = from
  for (const { record, proposal } of steps) {
    model = applyProposal(def, model, proposal)
    replayed.push({
      seq: record.seq,
      at: record.at,
      kind: "step",
      proposal: record.proposal,
      model,
      representation: def.state(model)
    })
  }
  return replayed
}

/**
 * Starts from the model of the record `seq` and re-applies the proposal of every later `step`
 * record in order, returning the recomputed records under their recorded `seq` and `at`; the record
 * `seq` itself is not repeated. The proposals are replayed as one linear sequence: a `travel`
 * record after `seq` restores nothing, so a history that branched replays its proposals, not its
 * branches. Fails with `NoSuchStep` when `records` holds no record `seq`.
 */
export const replayFrom = <D extends AnyDefinition>(
  def: D,
  records: ReadonlyArray<StepRecord<D>>,
  seq: number
): Result.Result<ReadonlyArray<StepRecord<D>>, NoSuchStep> =>
  Result.map(recordAt(records, seq), (start) => recompute(def, start.model, stepsAfter(records, seq)))

/** `replayInto` found the live loop at `seq` in a different state than the history recorded there. */
export class ReplayBaseMismatch extends Schema.TaggedError<ReplayBaseMismatch>()("ReplayBaseMismatch", {
  seq: Schema.Int
}) {}

/**
 * Replays on the live loop, through the ports alone: `travelTo(seq)`, then `present` for the
 * proposal of every later `step` record, in order. The loop's own history gains a `travel` record
 * and one `step` record per proposal, under new seqs.
 *
 * `travelTo(seq)` restores what the live loop recorded under `seq`, which is the recorded base only
 * if the loop made the same steps (an imported history, or a loop that has moved on, may not). After
 * the travel the live representation is compared with the representation recorded at `seq`, with
 * `Equal.equals` (a representation is plain data, and the ports expose no model): when they differ
 * nothing is presented, the loop stays at the state the travel restored, and it fails with
 * `ReplayBaseMismatch`. The comparison cannot see a model difference that the representation does
 * not show.
 *
 * Every `present` runs the loop's `nap`, and the recorded history already holds the automatic
 * proposals it produced. Reproducing the recording therefore needs a loop whose automatic actions
 * are off (`AutoActions` false); with them on, `nap` starts them again and they apply a second
 * time.
 *
 * Fails with `NoSuchStep` when `records` holds no record `seq`, before touching the ports, or when
 * the loop no longer retains it.
 */
export const replayInto = <D extends AnyDefinition, R>(
  ports: Ports<D, R>,
  records: ReadonlyArray<StepRecord<D>>,
  seq: number
): Effect.Effect<void, NoSuchStep | ReplayBaseMismatch, ModelPort<D> | HistoryPort<D>> =>
  Effect.gen(function*() {
    const base = yield* Effect.fromResult(recordAt(records, seq))
    const model = yield* ports.ModelPort
    const history = yield* ports.HistoryPort
    yield* history.travelTo(seq)
    const live = yield* Stream.runHead(model.representations)
    const isRecordedBase = Option.exists(live, (current) => Equal.equals(current, base.representation))
    if (!isRecordedBase) return yield* new ReplayBaseMismatch({ seq })
    yield* Effect.forEach(stepsAfter(records, seq), ({ proposal }) => model.present(proposal), { discard: true })
  })
