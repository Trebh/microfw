import { define, type Nap, noIntent, type SamDefinition, type WithTag } from "@mufw/core"
import { Effect, Option, Schema } from "effect"

/** One step of a route, or of a crossing: a proposal tag taking the stage from one place to another. */
export const Leg = Schema.Struct({ from: Schema.String, tag: Schema.String, to: Schema.String })
export type Leg = typeof Leg.Type

/** A route from the first place on the floor to `target`, one leg per step. */
export const Way = Schema.Struct({ target: Schema.String, legs: Schema.Array(Leg) })
export type Way = typeof Way.Type

/** A leg the visitor's history crossed, how often, and whether exploration had never tried it. */
export const Crossing = Schema.Struct({
  from: Schema.String,
  tag: Schema.String,
  to: Schema.String,
  count: Schema.Int,
  missed: Schema.Boolean
})
export type Crossing = typeof Crossing.Type

export const Model = Schema.Struct({
  phase: Schema.Literals(["resting", "walking", "done"]),
  ways: Schema.Array(Way),
  /** The route being walked. */
  way: Schema.Int,
  /** The leg being crossed; equal to the route's length once the light has arrived. */
  leg: Schema.Int,
  /** Steps taken since the walk began; its parity restarts the light's animation. */
  taken: Schema.Int,
  crossings: Schema.Array(Crossing),
  /** The `groupKey` of the leg crossed last, or "". */
  latest: Schema.String,
  /** The control state the shared stage stands in, or "". */
  standing: Schema.String
})
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("Started", {}),
  Schema.TaggedStruct("Rested", {}),
  Schema.TaggedStruct("Stepped", {}),
  Schema.TaggedStruct("Crossed", { from: Schema.String, tag: Schema.String, to: Schema.String, missed: Schema.Boolean }),
  Schema.TaggedStruct("Stood", { place: Schema.String })
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("Begin", {}),
  Schema.TaggedStruct("Rest", {}),
  Schema.TaggedStruct("Walk", { millis: Schema.Int })
])
export type Intent = typeof Intent.Type

export const Representation = Schema.Struct({
  controlState: Schema.Literals(["resting", "walking", "done"]),
  ways: Schema.Array(Way),
  way: Schema.Int,
  leg: Schema.Int,
  taken: Schema.Int,
  crossings: Schema.Array(Crossing),
  latest: Schema.String,
  standing: Schema.String
})
export type Representation = typeof Representation.Type

export const CROSSING_MILLIS = 800
export const QUICK_MILLIS = 150
export const ARRIVAL_MILLIS = 1400

export const sameLeg = (a: Leg, b: Leg): boolean => a.from === b.from && a.tag === b.tag && a.to === b.to

/** One arc of the floor: where it leaves, what takes it, where it lands. */
export const groupKey = (leg: Leg): string => `${leg.from}>${leg.tag}>${leg.to}`

/** Consecutive identical legs, folded: a run of seat holds is one stage direction, not eighteen. */
export interface Run {
  readonly leg: Leg
  readonly times: number
  /** Index in the route of the run's first leg. */
  readonly first: number
}

export const runsOf = (legs: ReadonlyArray<Leg>): ReadonlyArray<Run> =>
  legs.reduce<ReadonlyArray<Run>>((runs, leg, index) => {
    const last = runs.at(-1)
    if (last === undefined || !sameLeg(last.leg, leg)) return [...runs, { leg, times: 1, first: index }]
    return [...runs.slice(0, -1), { ...last, times: last.times + 1 }]
  }, [])

type Position = Pick<Representation, "ways" | "way" | "leg">

const legsOf = (position: Position): ReadonlyArray<Leg> => position.ways[position.way]?.legs ?? []

/** The leg the light is crossing now; none while it rests, after it arrives, or when the walk is not on. */
export const crossingNow = (representation: Representation): Option.Option<Leg> =>
  representation.controlState === "walking"
    ? Option.fromNullishOr(legsOf(representation)[representation.leg])
    : Option.none()

/** How long the light takes over its position: a repeated step is quick, an arrival lingers. */
export const legMillis = (position: Position): number => {
  const legs = legsOf(position)
  const current = legs[position.leg]
  if (current === undefined) return ARRIVAL_MILLIS
  const previous = legs[position.leg - 1]
  return previous !== undefined && sameLeg(previous, current) ? QUICK_MILLIS : CROSSING_MILLIS
}

export const initialSurvey = (ways: ReadonlyArray<Way>): Model => ({
  phase: "resting",
  ways,
  way: 0,
  leg: 0,
  taken: 0,
  crossings: [],
  latest: "",
  standing: ""
})


export const acceptStarted = (model: Model): Model => ({ ...model, phase: "walking", way: 0, leg: 0 })

export const acceptRested = (model: Model): Model => ({ ...model, phase: "resting", way: 0, leg: 0 })

const advance = (model: Model): Model => {
  const taken = model.taken + 1
  if (model.leg < legsOf(model).length) return { ...model, leg: model.leg + 1, taken }
  if (model.way + 1 < model.ways.length) return { ...model, way: model.way + 1, leg: 0, taken }
  return { ...model, phase: "done", taken }
}

/** A step that lands after the walk was stopped or finished changes nothing. */
export const acceptStepped = (model: Model): Model => (model.phase === "walking" ? advance(model) : model)

const countCrossing = (crossings: ReadonlyArray<Crossing>, leg: Leg, missed: boolean): ReadonlyArray<Crossing> =>
  crossings.some((crossing) => sameLeg(crossing, leg))
    ? crossings.map((crossing) => (sameLeg(crossing, leg) ? { ...crossing, count: crossing.count + 1 } : crossing))
    : [...crossings, { ...leg, count: 1, missed }]

export const acceptCrossed = (model: Model, proposal: WithTag<Proposal, "Crossed">): Model => {
  const leg = { from: proposal.from, tag: proposal.tag, to: proposal.to }
  return { ...model, crossings: countCrossing(model.crossings, leg, proposal.missed), latest: groupKey(leg) }
}

export const acceptStood = (model: Model, proposal: WithTag<Proposal, "Stood">): Model => ({
  ...model,
  standing: proposal.place
})

export const state = (model: Model): Representation => ({
  controlState: model.phase,
  ways: model.ways,
  way: model.way,
  leg: model.leg,
  taken: model.taken,
  crossings: model.crossings,
  latest: model.latest,
  standing: model.standing
})

/** While the walk is on, whisper the next step, and how long to wait before taking it. */
const whisperStep = (representation: Representation): Option.Option<Intent> =>
  Option.some({ _tag: "Walk", millis: legMillis(representation) })

const nap: Nap<Representation, Intent> = { resting: noIntent, walking: whisperStep, done: noIntent }

export type Survey = SamDefinition<typeof Model, typeof Proposal, typeof Intent, typeof Representation, never>

/**
 * The map's own loop: the walk of the light over the explored routes, what the visitor's history
 * crossed, and where the shared stage stands. It is built from the routes, so one definition serves
 * whatever graph the exploration found.
 */
export const makeSurvey = (ways: ReadonlyArray<Way>): Survey =>
  define({ name: "Survey", model: Model, proposal: Proposal, intent: Intent, representation: Representation })({
    initial: initialSurvey(ways),
    acceptors: {
      Started: acceptStarted,
      Rested: acceptRested,
      Stepped: acceptStepped,
      Crossed: acceptCrossed,
      Stood: acceptStood
    },
    reactors: [],
    state,
    nap,
    actions: {
      Begin: () => Effect.succeed({ _tag: "Started" } as const),
      Rest: () => Effect.succeed({ _tag: "Rested" } as const),
      Walk: ({ millis }) => Effect.sleep(millis).pipe(Effect.as({ _tag: "Stepped" } as const))
    }
  })
