import { Effect, Schema } from "effect"
import { define, noIntent } from "../../src/index.ts"

/** A running total with one control state: the parent of two counters that report their increments to it. */
export const Tally = define({
  name: "tally",
  model: Schema.Struct({ total: Schema.Int }),
  proposal: Schema.Union([Schema.TaggedStruct("Bumped", { by: Schema.Int }), Schema.TaggedStruct("Zeroed", {})]),
  intent: Schema.Union([Schema.TaggedStruct("Bump", { by: Schema.Int }), Schema.TaggedStruct("Zero", {})]),
  representation: Schema.Struct({ controlState: Schema.Literal("counting"), total: Schema.Int })
})({
  initial: { total: 0 },
  acceptors: {
    Bumped: (model, proposal) => ({ total: model.total + proposal.by }),
    Zeroed: () => ({ total: 0 })
  },
  reactors: [],
  state: (model) => ({ controlState: "counting", total: model.total }),
  nap: { counting: noIntent },
  actions: {
    Bump: (intent) => Effect.succeed({ _tag: "Bumped", by: intent.by }),
    Zero: () => Effect.succeed({ _tag: "Zeroed" })
  }
})
