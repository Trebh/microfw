import { define, type Forward, makePorts, noIntent, unchanged, type WithTag } from "@mufw/core"
import { Effect, Option, Ref, Schema, Stream, SubscriptionRef } from "effect"
import type { Deck } from "../../deck/Deck.ts"
import { type Representation as SeatsRepresentation, SeatId } from "../../domain/BoxOffice.ts"
import { House, send } from "./ticketHouse.ts"
import { CLOSE_CUE, RACE_CUE, script, SLOW_RACE_CUE } from "./script.ts"

/**
 * What the act's controls and the stage manager change: the slow line, the races run, whether
 * window A is open. A loop of its own, so that the deck's cues reach the windows through it.
 */
export const Model = Schema.Struct({
  windowA: Schema.Literals(["open", "closed"]),
  slowLine: Schema.Boolean,
  races: Schema.Int,
  lastSeat: Schema.Option(SeatId)
})
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("Raced", { seat: SeatId, slowLine: Schema.Boolean }),
  Schema.TaggedStruct("RaceSkipped", {}),
  Schema.TaggedStruct("LineSet", { slow: Schema.Boolean }),
  Schema.TaggedStruct("WindowAClosed", {}),
  Schema.TaggedStruct("WindowAReopened", {})
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("Race", { slowLine: Schema.Boolean }),
  Schema.TaggedStruct("SetSlowLine", { slow: Schema.Boolean }),
  Schema.TaggedStruct("CloseWindowA", {}),
  Schema.TaggedStruct("ReopenWindowA", {})
])
export type Intent = typeof Intent.Type

export const Representation = Schema.Struct({
  controlState: Schema.Literals(["both-open", "window-a-closed"]),
  slowLine: Schema.Boolean,
  races: Schema.Int,
  lastSeat: Schema.Option(SeatId)
})
export type Representation = typeof Representation.Type


export const acceptRaced = (model: Model, proposal: WithTag<Proposal, "Raced">): Model => ({
  ...model,
  slowLine: proposal.slowLine,
  races: model.races + 1,
  lastSeat: Option.some(proposal.seat)
})

export const acceptLineSet = (model: Model, proposal: WithTag<Proposal, "LineSet">): Model => ({
  ...model,
  slowLine: proposal.slow
})

export const acceptWindowAClosed = (model: Model): Model => ({ ...model, windowA: "closed" })

export const acceptWindowAReopened = (model: Model): Model => ({ ...model, windowA: "open" })

export const state = (model: Model): Representation => ({
  controlState: model.windowA === "open" ? "both-open" : "window-a-closed",
  slowLine: model.slowLine,
  races: model.races,
  lastSeat: model.lastSeat
})

/** A race needs the doors open; it is run for the first seat nobody has taken. */
export const raceableSeat = (representation: SeatsRepresentation): Option.Option<SeatId> => {
  if (representation.controlState !== "selling") return Option.none()
  const free = representation.seats.find((seat) => seat.status === "free")
  return Option.fromNullishOr(free?.id)
}

const seatToRace = (house: House["Service"]) =>
  house.windowB.model.representations.pipe(
    Stream.runHead,
    Effect.map(Option.flatMap(raceableSeat))
  )

/**
 * Both windows reach for the same seat. B is sent first, so that a win for A over a slow line is
 * the log's order and not the order of asking.
 */
const race = (slowLine: boolean) =>
  Effect.gen(function*() {
    const house = yield* House
    const windowA = yield* SubscriptionRef.get(house.windowA)
    const seat = yield* seatToRace(house)
    if (Option.isNone(windowA) || Option.isNone(seat)) return { _tag: "RaceSkipped" } as const
    yield* Ref.set(house.slowLine, slowLine)
    const hold = { _tag: "Hold", seat: seat.value } as const
    yield* Effect.all([send(house.windowB, hold), send(windowA.value, hold)], { concurrency: "unbounded", discard: true })
    return { _tag: "Raced", seat: seat.value, slowLine } as const
  })

export const Stagehand = define({
  name: "Stagehand",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  initial: { windowA: "open", slowLine: false, races: 0, lastSeat: Option.none() },
  acceptors: {
    Raced: acceptRaced,
    RaceSkipped: unchanged,
    LineSet: acceptLineSet,
    WindowAClosed: acceptWindowAClosed,
    WindowAReopened: acceptWindowAReopened
  },
  reactors: [],
  state,
  nap: { "both-open": noIntent, "window-a-closed": noIntent },
  actions: {
    Race: ({ slowLine }) => race(slowLine),
    SetSlowLine: ({ slow }) =>
      Effect.gen(function*() {
        const house = yield* House
        yield* Ref.set(house.slowLine, slow)
        return { _tag: "LineSet", slow } as const
      }),
    CloseWindowA: () =>
      Effect.gen(function*() {
        const house = yield* House
        yield* house.closeA
        return { _tag: "WindowAClosed" } as const
      }),
    ReopenWindowA: () =>
      Effect.gen(function*() {
        const house = yield* House
        yield* house.reopenA
        return { _tag: "WindowAReopened" } as const
      })
  }
})

export const StagehandPorts = makePorts(Stagehand)

const onCue: ReadonlyArray<readonly [cue: number, intent: Intent]> = [
  [RACE_CUE, { _tag: "Race", slowLine: false }],
  [SLOW_RACE_CUE, { _tag: "Race", slowLine: true }],
  [CLOSE_CUE, { _tag: "CloseWindowA" }]
]

/** The stage manager's cue sheet: an intent only on the deck's change into one of this act's cues, not on every representation after it. */
export const cueStagehand: Forward<typeof Deck, typeof Stagehand> = (previous, current) => {
  const isUp = (cue: number) => (deck: typeof current) => deck.actId === script.id && deck.cue === cue
  const entry = onCue.find(([cue]) => isUp(cue)(current) && !Option.exists(previous, isUp(cue)))
  return Option.fromNullishOr(entry?.[1])
}
