import {
  ActionFailure,
  define,
  type IntentPort,
  makePorts,
  type ModelPort,
  stepRecordSchema
} from "@mufw/core"
import { Effect, Option, Schema, Stream } from "effect"
import {
  BoxOffice,
  BoxOfficePorts,
  Intent as StageIntent,
  Model as StageModel,
  Patron,
  Representation as StageRepresentation,
  SeatId
} from "../../domain/BoxOffice.ts"
import { CurrentPatron } from "../../domain/CurrentPatron.ts"
import { Scene, sceneOf, settlesPayment, type StageRecord } from "./scene.ts"

const StageRecordSchema = stepRecordSchema(BoxOffice)

/** A payment the Action has taken offstage and the stage has not answered yet. */
const Charge = Schema.Struct({ seat: SeatId, by: Patron })
export type Charge = typeof Charge.Type

const Recent = Schema.Struct({ seq: Schema.Int, tag: Schema.String })

const Doors = Schema.Literals(["unchecked", "opened", "found-open"])

/**
 * What the act knows beyond the stage: the newest record of the stage (any kind), the newest `step`
 * record with the model before it, the payments in flight, and the tags of the latest scenes.
 */
export const Model = Schema.Struct({
  doors: Doors,
  charging: Schema.Array(Charge),
  stage: Schema.Option(StageRecordSchema),
  scene: Schema.Option(Schema.Struct({ record: StageRecordSchema, before: StageModel })),
  recent: Schema.Array(Recent)
})
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("Witnessed", { record: StageRecordSchema }),
  Schema.TaggedStruct("Asked", { intent: StageIntent, by: Patron }),
  Schema.TaggedStruct("HouseChecked", { opened: Schema.Boolean })
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("Ask", { intent: StageIntent }),
  Schema.TaggedStruct("OpenHouse", {})
])
export type Intent = typeof Intent.Type

export const Representation = Schema.Struct({
  controlState: Schema.Literals(["waiting", "playing", "offstage"]),
  doors: Doors,
  stage: Schema.Option(StageRepresentation),
  charging: Schema.Array(Charge),
  scene: Schema.Option(Scene),
  recent: Schema.Array(Recent)
})
export type Representation = typeof Representation.Type

export const initial: Model = {
  doors: "unchecked",
  charging: [],
  stage: Option.none(),
  scene: Option.none(),
  recent: []
}

const MAX_RECENT = 5

const settledCharges = (model: Model, record: StageRecord): ReadonlyArray<Charge> =>
  model.charging.filter((charge) => !Option.exists(record.proposal, (proposal) => settlesPayment(proposal, charge.seat)))

const recentAfter = (model: Model, record: StageRecord): Model["recent"] => {
  const tags = Option.toArray(Option.map(record.proposal, (proposal) => ({ seq: record.seq, tag: proposal._tag })))
  return [...model.recent, ...tags].slice(-MAX_RECENT)
}

const modelBefore = (model: Model): StageModel =>
  Option.match(model.stage, { onNone: () => BoxOffice.initial, onSome: (previous) => previous.model })

/** A record of the stage arrives: the house repaints from it, and a `step` also becomes the scene on show. */
export const acceptWitnessed = (model: Model, proposal: Proposal): Model => {
  if (proposal._tag !== "Witnessed") return model
  const { record } = proposal
  const seen: Model = { ...model, stage: Option.some(record), charging: settledCharges(model, record) }
  if (record.kind !== "step") return seen
  return {
    ...seen,
    scene: Option.some({ record, before: modelBefore(model) }),
    recent: recentAfter(model, record)
  }
}

/** A payment the audience asked for is in flight until the stage answers it. */
export const acceptAsked = (model: Model, proposal: Proposal): Model => {
  if (proposal._tag !== "Asked" || proposal.intent._tag !== "Pay") return model
  const { seat } = proposal.intent
  if (model.charging.some((charge) => charge.seat === seat)) return model
  return { ...model, charging: [...model.charging, { seat, by: proposal.by }] }
}

export const acceptHouseChecked = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "HouseChecked" ? { ...model, doors: proposal.opened ? "opened" : "found-open" } : model

const heldSeats = (model: Model): ReadonlyArray<SeatId> =>
  Option.match(model.stage, {
    onNone: () => [],
    onSome: (record) => record.representation.seats.flatMap((seat) => (seat.status === "held" ? [seat.id] : []))
  })

/** A payment cannot be in flight for a seat nobody holds any more: the hold ran out, or the curtain rose. */
export const dropChargesWithoutHold = (model: Model): Model => {
  const held = heldSeats(model)
  const kept = model.charging.filter((charge) => held.includes(charge.seat))
  return kept.length === model.charging.length ? model : { ...model, charging: kept }
}

const controlStateOf = (model: Model): Representation["controlState"] => {
  if (model.charging.length > 0) return "offstage"
  return Option.isSome(model.scene) ? "playing" : "waiting"
}

const sceneOnShow = (model: Model): Option.Option<Scene> =>
  Option.flatMap(model.scene, ({ before, record }) => sceneOf(record, before))

export const state = (model: Model): Representation => ({
  controlState: controlStateOf(model),
  doors: model.doors,
  stage: Option.map(model.stage, (record) => record.representation),
  charging: model.charging,
  scene: sceneOnShow(model),
  recent: model.recent
})

const refusedAs = (intent: StageIntent) => (refused: { readonly message: string }) =>
  new ActionFailure({ intentTag: intent._tag, message: refused.message })

/** What the board's actions reach for: who is buying, and the shared stage they relay to and read. */
export type LoopBoardServices = CurrentPatron | IntentPort<typeof BoxOffice> | ModelPort<typeof BoxOffice>

export const LoopBoard = define({
  name: "LoopBoard",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})<LoopBoardServices>({
  controlStates: ["waiting", "playing", "offstage"],
  initial,
  acceptors: [acceptWitnessed, acceptAsked, acceptHouseChecked],
  reactors: [dropChargesWithoutHold],
  state,
  nap: () => Option.none(),
  actions: {
    Ask: ({ intent }) =>
      Effect.gen(function*() {
        const { patron } = yield* CurrentPatron
        const stage = yield* BoxOfficePorts.IntentPort
        yield* stage.dispatch(intent).pipe(Effect.mapError(refusedAs(intent)))
        return { _tag: "Asked", intent, by: patron } as const
      }),
    OpenHouse: () =>
      Effect.gen(function*() {
        const stage = yield* BoxOfficePorts.ModelPort
        const intents = yield* BoxOfficePorts.IntentPort
        const current = yield* Stream.runHead(stage.representations)
        const isDark = Option.exists(current, (representation) => representation.controlState === "dark")
        const doors: StageIntent = { _tag: "OpenDoors" }
        if (isDark) yield* intents.dispatch(doors).pipe(Effect.mapError(refusedAs(doors)))
        return { _tag: "HouseChecked", opened: isDark } as const
      })
  }
})

export const LoopBoardPorts = makePorts(LoopBoard)
