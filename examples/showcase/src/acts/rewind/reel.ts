import { proposalLabel, replayFrom, type StepRecord, stepRecordSchema } from "@mufw/core"
import { Equal, Option, Result, Schema } from "effect"
import { BoxOffice, SeatView } from "../../domain/BoxOffice.ts"

/** What the box office writes down for every step, as its history holds it. */
export type BoxRecord = StepRecord<typeof BoxOffice>
export const BoxRecord = stepRecordSchema(BoxOffice)

/** One exposure of the film: a record, reduced to what a frame shows. */
export const Frame = Schema.Struct({
  seq: Schema.Int,
  kind: Schema.Literals(["init", "step", "travel", "restore"]),
  label: Schema.String,
  travelledTo: Schema.Option(Schema.Int),
  seats: Schema.Array(SeatView),
  held: Schema.Int,
  sold: Schema.Int,
  /** Records between this one and the newest: 0 is the newest. */
  age: Schema.Int
})
export type Frame = typeof Frame.Type

const Replayed = Schema.Struct({ seq: Schema.Int, label: Schema.String, equal: Schema.Boolean })

/** The outcome of replaying the proposals that followed a frame, against what was recorded. */
export const Verdict = Schema.Struct({
  from: Schema.Int,
  /** The seq of the next travel, where the straight stretch of the film ends; none if it runs to the newest record. */
  until: Schema.Option(Schema.Int),
  replayed: Schema.Array(Replayed),
  equalCount: Schema.Int,
  agrees: Schema.Boolean
})
export type Verdict = typeof Verdict.Type

/** What a record is called on the reel: its proposal's label, or its kind for a record that has none. */
export const labelOf = (record: BoxRecord): string =>
  Option.match(record.proposal, { onNone: () => record.kind, onSome: (proposal) => proposalLabel(BoxOffice, proposal) })

export const framesOf = (records: ReadonlyArray<BoxRecord>): ReadonlyArray<Frame> => {
  const newest = records.length - 1
  return records.map((record, index): Frame => ({
    seq: record.seq,
    kind: record.kind,
    label: labelOf(record),
    travelledTo: Option.fromNullishOr(record.travelledTo),
    seats: record.representation.seats,
    held: record.representation.held,
    sold: record.representation.sold,
    age: newest - index
  }))
}

/** The seq whose house the stage shows: the newest record's own, or the one a newest travel restored. */
export const positionOf = (records: ReadonlyArray<BoxRecord>): Option.Option<number> =>
  Option.map(Option.fromNullishOr(records.at(-1)), (newest) => newest.travelledTo ?? newest.seq)

const isStep = (record: BoxRecord): boolean => record.kind === "step"

const isDoorsOpened = (record: BoxRecord): boolean =>
  isStep(record) && Option.exists(record.proposal, (proposal) => proposal._tag === "DoorsOpened")

/** The frame where the doors opened; the first step if the doors never did. */
export const doorsOf = (records: ReadonlyArray<BoxRecord>): Option.Option<number> =>
  Option.fromNullishOr((records.find(isDoorsOpened) ?? records.find(isStep))?.seq)

const nextTravelAfter = (records: ReadonlyArray<BoxRecord>, seq: number): Option.Option<number> =>
  Option.fromNullishOr(records.find((record) => record.seq > seq && record.kind === "travel")?.seq)

/** `replayFrom` replays proposals as one line: a travel in the records would restore nothing, so the film is cut at it. */
const straightStretch = (records: ReadonlyArray<BoxRecord>, seq: number, until: Option.Option<number>) =>
  records.filter((record) => record.seq >= seq && Option.match(until, { onNone: () => true, onSome: (end) => record.seq < end }))

const agreementOf = (recorded: ReadonlyMap<number, BoxRecord>) => (replayed: BoxRecord) => ({
  seq: replayed.seq,
  label: labelOf(replayed),
  equal: Option.exists(Option.fromNullishOr(recorded.get(replayed.seq)), (record) => Equal.equals(record.model, replayed.model))
})

/**
 * Replays, as a pure function, every proposal recorded after `seq` up to the next travel, and
 * compares each replayed model with the recorded one. None when the film holds no frame `seq`.
 */
export const replayVerdict = (records: ReadonlyArray<BoxRecord>, seq: number): Option.Option<Verdict> => {
  const until = nextTravelAfter(records, seq)
  const stretch = straightStretch(records, seq, until)
  const replayed = Result.getSuccess(replayFrom(BoxOffice, stretch, seq))
  const recorded = new Map(stretch.map((record) => [record.seq, record] as const))
  return Option.map(replayed, (replayedRecords) => {
    const agreements = replayedRecords.map(agreementOf(recorded))
    const equalCount = agreements.filter((agreement) => agreement.equal).length
    return { from: seq, until, replayed: agreements, equalCount, agrees: equalCount === agreements.length }
  })
}
