import { applyProposal, type StepRecord } from "@mufw/core"
import { Option, Schema } from "effect"
import {
  BoxOffice,
  Intent as StageIntent,
  type Model as StageModel,
  type Place,
  Proposal as StageProposal,
  SeatId
} from "../../domain/BoxOffice.ts"

/** A record of the shared stage: what the box office's `HistoryPort` emits. */
export type StageRecord = StepRecord<typeof BoxOffice>

/** The seven stations of one step, in the order the light runs along them. */
export const STATIONS = ["intent", "action", "proposal", "acceptors", "reactors", "state", "nap"] as const
export type StationId = (typeof STATIONS)[number]

export const Change = Schema.Struct({ field: Schema.String, change: Schema.String })
export type Change = typeof Change.Type

/** Everything the right-hand side of the act says about one `step` record, derived purely from it and the model before it. */
export const Scene = Schema.Struct({
  seq: Schema.Int,
  proposal: StageProposal,
  intent: Schema.String,
  automatic: Schema.Boolean,
  movers: Schema.Array(Schema.String),
  changes: Schema.Array(Change),
  freed: Schema.Array(SeatId),
  controlState: Schema.String,
  free: Schema.Int,
  held: Schema.Int,
  sold: Schema.Int,
  whispers: Schema.Array(StageIntent)
})
export type Scene = typeof Scene.Type

/** The intent whose action brings back each proposal; exhaustive, so a new proposal cannot be forgotten. */
const intentBehind: Readonly<Record<StageProposal["_tag"], StageIntent["_tag"]>> = {
  DoorsOpened: "OpenDoors",
  SeatHeld: "Hold",
  SeatSold: "Pay",
  PaymentDeclined: "Pay",
  Ticked: "AwaitExpiry",
  CurtainRaised: "RaiseCurtain"
}

/** Intents that NAP, not the audience, asks for. */
const whisperedIntents: Readonly<Record<StageIntent["_tag"], boolean>> = {
  OpenDoors: false,
  Hold: false,
  Pay: false,
  AwaitExpiry: true,
  RaiseCurtain: true
}

/** The seat a proposal is about, when it names one. */
export const seatOf = (proposal: StageProposal): Option.Option<SeatId> =>
  "seat" in proposal ? Option.some(proposal.seat) : Option.none()

/** True when `proposal` is the outcome of paying for `seat`. */
export const settlesPayment = (proposal: StageProposal, seat: SeatId): boolean =>
  (proposal._tag === "SeatSold" || proposal._tag === "PaymentDeclined") && proposal.seat === seat

const intentLabel = (proposal: StageProposal): string => {
  const tag = intentBehind[proposal._tag]
  return Option.match(seatOf(proposal), { onNone: () => tag, onSome: (seat) => `${tag} ${seat}` })
}

/** The acceptor that returned a model other than the one it was given, if any: only the one named after the proposal's tag can. */
export const acceptorsThatMoved = (before: StageModel, proposal: StageProposal): ReadonlyArray<string> =>
  BoxOffice.acceptors.some((accept) => accept(before, proposal) !== before) ? [`accept${proposal._tag}`] : []

const withoutReactors: typeof BoxOffice = { ...BoxOffice, reactors: [] }

/** Seats the reactors freed: held after the acceptors alone, free once the reactors have run. */
export const seatsFreedByReactors = (before: StageModel, proposal: StageProposal): ReadonlyArray<SeatId> => {
  const accepted = applyProposal(withoutReactors, before, proposal)
  const reacted = applyProposal(BoxOffice, before, proposal)
  const stillHeld = new Set(reacted.seats.flatMap((place) => (place._tag === "Held" ? [place.seat] : [])))
  return accepted.seats.flatMap((place) => (place._tag === "Held" && !stillHeld.has(place.seat) ? [place.seat] : []))
}

const describePlace = (place: Place): string => (place._tag === "Free" ? "free" : `${place._tag.toLowerCase()} by ${place.by}`)

const fingerprint = (place: Place): string => `${describePlace(place)}@${place._tag === "Held" ? place.until : 0}`

const phaseChange = (before: StageModel, after: StageModel): ReadonlyArray<Change> =>
  before.phase === after.phase ? [] : [{ field: "phase", change: `${before.phase} → ${after.phase}` }]

const clockChange = (before: StageModel, after: StageModel): ReadonlyArray<Change> => {
  if (before.now === after.now) return []
  if (before.now === 0) return [{ field: "now", change: "the clock starts" }]
  const seconds = (after.now - before.now) / 1000
  return [{ field: "now", change: `${seconds > 0 ? "+" : ""}${seconds.toFixed(1)} s` }]
}

const seatChanges = (before: StageModel, after: StageModel): ReadonlyArray<Change> =>
  after.seats.flatMap((place): ReadonlyArray<Change> => {
    const was = before.seats.find((candidate) => candidate.seat === place.seat)
    if (was === undefined || fingerprint(was) === fingerprint(place)) return []
    return [{ field: `seats.${place.seat}`, change: `${describePlace(was)} → ${describePlace(place)}` }]
  })

const refusalChange = (before: StageModel, after: StageModel): ReadonlyArray<Change> => {
  const was = Option.getOrElse(before.lastRefusal, () => "")
  const now = Option.getOrElse(after.lastRefusal, () => "")
  if (was === now) return []
  return [{ field: "lastRefusal", change: now === "" ? "cleared" : `“${now}”` }]
}

/** The model fields that differ between two models; a pure diff, in model order. */
export const diffModels = (before: StageModel, after: StageModel): ReadonlyArray<Change> => [
  ...phaseChange(before, after),
  ...clockChange(before, after),
  ...seatChanges(before, after),
  ...refusalChange(before, after)
]

/** The scene of a `step` record, given the model of the record before it; `none` for a record that carries no proposal. */
export const sceneOf = (record: StageRecord, before: StageModel): Option.Option<Scene> =>
  Option.map(record.proposal, (proposal) => ({
    seq: record.seq,
    proposal,
    intent: intentLabel(proposal),
    automatic: whisperedIntents[intentBehind[proposal._tag]],
    movers: acceptorsThatMoved(before, proposal),
    changes: diffModels(before, record.model),
    freed: seatsFreedByReactors(before, proposal),
    controlState: record.representation.controlState,
    free: record.representation.free,
    held: record.representation.held,
    sold: record.representation.sold,
    whispers: BoxOffice.nap(record.representation)
  }))

/** Which stations did something in this scene; the rest only let the light pass. */
export const firedStations = (scene: Scene): ReadonlyArray<boolean> => [
  true,
  true,
  true,
  scene.changes.length > 0,
  scene.freed.length > 0,
  true,
  scene.whispers.length > 0
]

/** A proposal as the stage writes it down: its tag, then its fields. */
export const proposalText = (proposal: StageProposal): string => {
  const { _tag, ...fields } = proposal
  const entries = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  return entries.length === 0 ? `${_tag} {}` : `${_tag} { ${entries.join(", ")} }`
}
