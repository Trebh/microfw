import { define, makePorts, noIntent } from "@mufw/core"
import { Effect, Schema } from "effect"

/** The smallest useful definition: what every µFW application pays for at least. */
export const Counter = define({
  name: "benchCounter",
  model: Schema.Struct({ count: Schema.Int }),
  proposal: Schema.Union([Schema.TaggedStruct("Inc", { by: Schema.Int })]),
  intent: Schema.Union([Schema.TaggedStruct("Inc", { by: Schema.Int })]),
  representation: Schema.Struct({ controlState: Schema.Literals(["even", "odd"]), count: Schema.Int })
})({
  initial: { count: 0 },
  acceptors: { Inc: (model, proposal) => ({ count: model.count + proposal.by }) },
  reactors: [],
  state: (model) => ({ controlState: model.count % 2 === 0 ? "even" : "odd", count: model.count }),
  nap: { even: noIntent, odd: noIntent },
  actions: {
    Inc: (intent) => Effect.succeed({ _tag: "Inc", by: intent.by })
  }
})

export const CounterPorts = makePorts(Counter)
