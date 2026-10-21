import { Effect, Option, Schema } from "effect"
import { ActionFailure, define, makePorts } from "../../src/index.ts"

export const Model = Schema.Struct({ count: Schema.Int })
export const Proposal = Schema.Union([
  Schema.TaggedStruct("Inc", { by: Schema.Int }),
  Schema.TaggedStruct("Reset", {})
])
export const Intent = Schema.Union([
  Schema.TaggedStruct("Inc", { by: Schema.Int }),
  Schema.TaggedStruct("Reset", {}),
  Schema.TaggedStruct("AutoReset", {}),
  Schema.TaggedStruct("Fail", {})
])
export const Representation = Schema.Struct({
  controlState: Schema.Literals(["low", "high"]),
  count: Schema.Int
})

export const Counter = define({
  name: "counter",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  controlStates: ["low", "high"],
  initial: { count: 0 },
  acceptors: [
    (model, proposal) => (proposal._tag === "Inc" ? { count: model.count + proposal.by } : model),
    (model, proposal) => (proposal._tag === "Reset" ? { count: 0 } : model)
  ],
  reactors: [],
  state: (model) => ({ controlState: model.count >= 3 ? "high" : "low", count: model.count }),
  nap: (representation) => (representation.count >= 3 ? Option.some({ _tag: "AutoReset" }) : Option.none()),
  actions: {
    Inc: (intent) => Effect.succeed({ _tag: "Inc", by: intent.by }),
    Reset: () => Effect.succeed({ _tag: "Reset" }),
    AutoReset: () => Effect.sleep("1 second").pipe(Effect.as({ _tag: "Reset" })),
    Fail: () => Effect.fail(new ActionFailure({ intentTag: "Fail", message: "boom" }))
  }
})

export const Ports = makePorts(Counter)
