import { define } from "@mufw/core"
import { Effect, Option, Schema } from "effect"
import { SEAT_IDS } from "../../domain/Values.ts"

export const SIGNS = ["tonight", "few", "sold", "playing"] as const
export const Sign = Schema.Literals(SIGNS)
export type Sign = typeof Sign.Type

/** How long the painter takes to climb the ladder and change the sign. */
export const PAINTER_MILLIS = 420

export const Model = Schema.Struct({
  sign: Sign,
  free: Schema.Int,
  repaints: Schema.Int
})
export type Model = typeof Model.Type

export const Proposal = Schema.TaggedStruct("Repainted", { sign: Sign, free: Schema.Int })
export type Proposal = typeof Proposal.Type

export const Intent = Schema.TaggedStruct("Repaint", { sign: Sign, free: Schema.Int })
export type Intent = typeof Intent.Type

export const Representation = Schema.Struct({
  controlState: Sign,
  free: Schema.Int,
  /** How many times the sign has been repainted: the page flickers the sign in on each. */
  repaints: Schema.Int
})
export type Representation = typeof Representation.Type

export const acceptRepainted = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "Repainted"
    ? { sign: proposal.sign, free: proposal.free, repaints: model.repaints + 1 }
    : model

export const state = (model: Model): Representation => ({
  controlState: model.sign,
  free: model.free,
  repaints: model.repaints
})

/** The sign outside the theatre: it says what it was last told, and nothing else. */
export const Marquee = define({
  name: "Marquee",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  controlStates: SIGNS,
  initial: { sign: "tonight", free: SEAT_IDS.length, repaints: 0 },
  acceptors: [acceptRepainted],
  reactors: [],
  state,
  nap: () => Option.none(),
  actions: {
    Repaint: ({ sign, free }) => Effect.sleep(PAINTER_MILLIS).pipe(Effect.as({ _tag: "Repainted", sign, free } as const))
  }
})
