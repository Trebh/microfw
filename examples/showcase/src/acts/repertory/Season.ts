import { define, noIntent, type WithTag } from "@mufw/core"
import { Clock, Effect, Option, Schema } from "effect"

/** The nights the bill can offer, in the order Programme offers them. Three fit the stage side by side. */
export const NIGHTS = ["Fri", "Sat", "Sun"] as const

export const Model = Schema.Struct({
  /** The nights on the bill, in order: the keys of the collection of box offices. */
  programme: Schema.Array(Schema.String),
  played: Schema.Array(Schema.String),
  openedAt: Schema.Option(Schema.Number)
})
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("NightProgrammed", { night: Schema.String }),
  Schema.TaggedStruct("NightCancelled", { night: Schema.String }),
  Schema.TaggedStruct("SeasonOpened", { at: Schema.Number }),
  // No action proposes it: a night's `CurtainRaised` reaches the season as this.
  Schema.TaggedStruct("NightPlayed", { night: Schema.String })
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("ProgrammeNight", { night: Schema.String }),
  Schema.TaggedStruct("CancelNight", { night: Schema.String }),
  Schema.TaggedStruct("OpenSeason", {})
])
export type Intent = typeof Intent.Type

export const Representation = Schema.Struct({
  controlState: Schema.Literals(["planning", "open", "over"]),
  programme: Schema.Array(Schema.String),
  played: Schema.Array(Schema.String),
  /** The night Programme would add next, if any is left. */
  next: Schema.Option(Schema.String)
})
export type Representation = typeof Representation.Type

export const initial: Model = { programme: [], played: [], openedAt: Option.none() }

const without = (nights: ReadonlyArray<string>, night: string): ReadonlyArray<string> =>
  nights.filter((listed) => listed !== night)

const withNight = (nights: ReadonlyArray<string>, night: string): ReadonlyArray<string> =>
  nights.includes(night) ? nights : [...nights, night]

export const acceptNightProgrammed = (model: Model, proposal: WithTag<Proposal, "NightProgrammed">): Model => ({
  ...model,
  programme: withNight(model.programme, proposal.night)
})

export const acceptNightCancelled = (model: Model, proposal: WithTag<Proposal, "NightCancelled">): Model => ({
  ...model,
  programme: without(model.programme, proposal.night)
})

export const acceptSeasonOpened = (model: Model, proposal: WithTag<Proposal, "SeasonOpened">): Model =>
  Option.isNone(model.openedAt) ? { ...model, openedAt: Option.some(proposal.at) } : model

export const acceptNightPlayed = (model: Model, proposal: WithTag<Proposal, "NightPlayed">): Model => ({
  ...model,
  programme: without(model.programme, proposal.night),
  played: withNight(model.played, proposal.night)
})

const controlStateOf = (model: Model): Representation["controlState"] => {
  if (Option.isNone(model.openedAt)) return "planning"
  return model.programme.length === 0 ? "over" : "open"
}

const nextNight = (model: Model): Option.Option<string> =>
  Option.fromNullishOr(NIGHTS.find((night) => !model.programme.includes(night) && !model.played.includes(night)))

export const state = (model: Model): Representation => ({
  controlState: controlStateOf(model),
  programme: model.programme,
  played: model.played,
  next: nextNight(model)
})

const programmeNight = ({ night }: WithTag<Intent, "ProgrammeNight">) =>
  Effect.succeed({ _tag: "NightProgrammed", night } as const)

const cancelNight = ({ night }: WithTag<Intent, "CancelNight">) => Effect.succeed({ _tag: "NightCancelled", night } as const)

const openSeason = () => Clock.currentTimeMillis.pipe(Effect.map((at) => ({ _tag: "SeasonOpened", at }) as const))

/** The season's bill: which nights it lists. It does not sell a seat; each night's box office does. */
export const Season = define({
  name: "Season",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  initial,
  acceptors: {
    NightProgrammed: acceptNightProgrammed,
    NightCancelled: acceptNightCancelled,
    SeasonOpened: acceptSeasonOpened,
    NightPlayed: acceptNightPlayed
  },
  reactors: [],
  state,
  nap: { planning: noIntent, open: noIntent, over: noIntent },
  actions: { ProgrammeNight: programmeNight, CancelNight: cancelNight, OpenSeason: openSeason }
})
