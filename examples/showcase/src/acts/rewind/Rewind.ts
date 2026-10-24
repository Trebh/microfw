import { ActionFailure, define, type HistoryPort, type IntentPort, makePorts } from "@mufw/core"
import { Effect, Option, Schema } from "effect"
import {
  BoxOffice,
  BoxOfficePorts,
  type Intent as StageIntent,
  Representation as StageRepresentation,
  SeatId
} from "../../domain/BoxOffice.ts"
import { BoxRecord, doorsOf, Frame, framesOf, positionOf, replayVerdict, Verdict } from "./reel.ts"

/**
 * The reel: the box office's records, as this act's own loop holds them. `selected` is the frame
 * the scrubber rests on while the visitor chooses; none means the one the stage shows.
 */
export const Model = Schema.Struct({
  records: Schema.Array(BoxRecord),
  selected: Schema.Option(Schema.Int),
  travels: Schema.Int,
  exports: Schema.Int,
  pendingStart: Schema.Boolean,
  note: Schema.Option(Schema.String)
})
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("Recorded", { record: BoxRecord }),
  Schema.TaggedStruct("Selected", { seq: Schema.Int }),
  Schema.TaggedStruct("Travelled", { seq: Schema.Int }),
  Schema.TaggedStruct("TravelRefused", { seq: Schema.Int }),
  Schema.TaggedStruct("ReturnRequested", {}),
  Schema.TaggedStruct("ExportRequested", {}),
  Schema.TaggedStruct("HandedToStage", { intent: Schema.String })
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("TravelTo", { seq: Schema.Int }),
  Schema.TaggedStruct("Select", { seq: Schema.Int }),
  Schema.TaggedStruct("ReturnToDoors", {}),
  Schema.TaggedStruct("Export", {}),
  Schema.TaggedStruct("OpenDoors", {}),
  Schema.TaggedStruct("Hold", { seat: SeatId })
])
export type Intent = typeof Intent.Type

export const Representation = Schema.Struct({
  controlState: Schema.Literals(["blank", "recording", "rewound"]),
  reel: Schema.Array(BoxRecord),
  frames: Schema.Array(Frame),
  /** The house of the newest record: the stage as it is now. */
  stage: Schema.Option(StageRepresentation),
  /** The seq whose house the stage shows. */
  position: Schema.Option(Schema.Int),
  /** The frame the scrubber rests on: the chosen one, else the position. */
  selected: Schema.Option(Schema.Int),
  selectedIndex: Schema.Int,
  verdict: Schema.Option(Verdict),
  doors: Schema.Option(Schema.Int),
  /** What became of the wait for the earliest hold: running offstage, or cut short by the newest travel. */
  holdWait: Schema.Literals(["none", "inflight", "interrupted"]),
  travels: Schema.Int,
  exports: Schema.Int,
  pendingStart: Schema.Boolean,
  note: Schema.Option(Schema.String),
  /** Changes when the film should be scrolled to the selected frame: a new selection or a new frame. */
  follow: Schema.String
})
export type Representation = typeof Representation.Type

export const initial: Model = {
  records: [],
  selected: Option.none(),
  travels: 0,
  exports: 0,
  pendingStart: false,
  note: Option.none()
}

/** A travel that reaches the reel answers a pending return, so the prompter does not ask for it twice. */
export const acceptRecorded = (model: Model, proposal: Proposal): Model => {
  if (proposal._tag !== "Recorded") return model
  const { record } = proposal
  if (model.records.some((known) => known.seq === record.seq)) return model
  const answered = record.kind === "travel"
  return { ...model, records: [...model.records, record], pendingStart: model.pendingStart && !answered }
}

export const acceptSelected = (model: Model, proposal: Proposal): Model => {
  if (proposal._tag !== "Selected") return model
  const exists = model.records.some((record) => record.seq === proposal.seq)
  return exists ? { ...model, selected: Option.some(proposal.seq) } : model
}

export const acceptTravelled = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "Travelled"
    ? { ...model, selected: Option.none(), pendingStart: false, note: Option.none(), travels: model.travels + 1 }
    : model

export const acceptTravelRefused = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "TravelRefused"
    ? {
      ...model,
      selected: Option.none(),
      pendingStart: false,
      note: Option.some(`The stage no longer has frame ${proposal.seq}, so it can't go back there.`)
    }
    : model

/** Going back to the doors needs a frame where they opened; without one the request is answered with a note. */
export const acceptReturnRequested = (model: Model, proposal: Proposal): Model => {
  if (proposal._tag !== "ReturnRequested") return model
  if (Option.isSome(doorsOf(model.records))) return { ...model, pendingStart: true }
  return { ...model, note: Option.some("Nothing has happened on the stage yet. Open the doors and hold a seat, then go back.") }
}

export const acceptExportRequested = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "ExportRequested" ? { ...model, exports: model.exports + 1 } : model

/** A new scene on the stage makes any earlier note stale. */
export const acceptHandedToStage = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "HandedToStage" ? { ...model, note: Option.none() } : model

/** A hold keeps an `AwaitExpiry` waiting offstage; a travel interrupts it and no `nap` runs until the next proposal. */
const holdWaitOf = (newest: BoxRecord | undefined): Representation["holdWait"] => {
  if (newest === undefined || newest.representation.held === 0) return "none"
  return newest.kind === "travel" ? "interrupted" : "inflight"
}

const controlStateOf = (newest: BoxRecord | undefined): Representation["controlState"] => {
  if (newest === undefined) return "blank"
  return newest.kind === "travel" ? "rewound" : "recording"
}

export const state = (model: Model): Representation => {
  const { records } = model
  const frames = framesOf(records)
  const position = positionOf(records)
  const selected = Option.orElse(model.selected, () => position)
  const newest = records.at(-1)
  return {
    controlState: controlStateOf(newest),
    reel: records,
    frames,
    stage: Option.map(Option.fromNullishOr(newest), (record) => record.representation),
    position,
    selected,
    selectedIndex: Option.match(selected, {
      onNone: () => 0,
      onSome: (seq) => Math.max(0, frames.findIndex((frame) => frame.seq === seq))
    }),
    verdict: Option.flatMap(selected, (seq) => replayVerdict(records, seq)),
    doors: doorsOf(records),
    holdWait: holdWaitOf(newest),
    travels: model.travels,
    exports: model.exports,
    pendingStart: model.pendingStart,
    note: model.note,
    follow: `${Option.getOrElse(selected, () => -1)}:${frames.length}`
  }
}

/** The prompter's whisper: once going back is requested and there is a frame to go back to, go. */
export const nap = (representation: Representation): Option.Option<Intent> =>
  representation.pendingStart
    ? Option.map(representation.doors, (seq) => ({ _tag: "TravelTo", seq }) as const)
    : Option.none()

const handToStage = Effect.fn("handToStage")(function*(intent: StageIntent) {
  const stage = yield* BoxOfficePorts.IntentPort
  yield* stage.dispatch(intent).pipe(
    Effect.mapError((refused) => new ActionFailure({ intentTag: intent._tag, message: refused.message }))
  )
  return { _tag: "HandedToStage", intent: intent._tag } as const
})

/** The only effect of the act on the stage's history: a travel, and what became of it. */
const travelTo = Effect.fn("travelTo")(function*(seq: number) {
  const history = yield* BoxOfficePorts.HistoryPort
  return yield* history.travelTo(seq).pipe(
    Effect.as({ _tag: "Travelled", seq } as const),
    Effect.catchTag("NoSuchStep", () => Effect.succeed({ _tag: "TravelRefused", seq } as const))
  )
})

export const Rewind = define({
  name: "Rewind",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})<HistoryPort<typeof BoxOffice> | IntentPort<typeof BoxOffice>>({
  controlStates: ["blank", "recording", "rewound"],
  initial,
  acceptors: [
    acceptRecorded,
    acceptSelected,
    acceptTravelled,
    acceptTravelRefused,
    acceptReturnRequested,
    acceptExportRequested,
    acceptHandedToStage
  ],
  reactors: [],
  state,
  nap,
  actions: {
    TravelTo: ({ seq }) => travelTo(seq),
    Select: ({ seq }) => Effect.succeed({ _tag: "Selected", seq }),
    ReturnToDoors: () => Effect.succeed({ _tag: "ReturnRequested" }),
    Export: () => Effect.succeed({ _tag: "ExportRequested" }),
    OpenDoors: () => handToStage({ _tag: "OpenDoors" }),
    Hold: ({ seat }) => handToStage({ _tag: "Hold", seat })
  }
})

export const RewindPorts = makePorts(Rewind)
