import { define, makePorts } from "@mufw/core"
import { Effect, Option, Schema } from "effect"

/** The smallest useful definition: what every µFW application pays for at least. */
export const Counter = define({
  name: "benchCounter",
  model: Schema.Struct({ count: Schema.Int }),
  proposal: Schema.Union([Schema.TaggedStruct("Inc", { by: Schema.Int })]),
  intent: Schema.Union([Schema.TaggedStruct("Inc", { by: Schema.Int })]),
  representation: Schema.Struct({ controlState: Schema.Literals(["even", "odd"]), count: Schema.Int })
})({
  controlStates: ["even", "odd"],
  initial: { count: 0 },
  acceptors: [(model, proposal) => (proposal._tag === "Inc" ? { count: model.count + proposal.by } : model)],
  reactors: [],
  state: (model) => ({ controlState: model.count % 2 === 0 ? "even" : "odd", count: model.count }),
  nap: () => Option.none(),
  actions: {
    Inc: (intent) => Effect.succeed({ _tag: "Inc", by: intent.by })
  }
})

export const CounterPorts = makePorts(Counter)
