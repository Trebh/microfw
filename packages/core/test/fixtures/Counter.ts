import { Effect, Option, Schema } from "effect"
import { type Acceptors, ActionFailure, define, makePorts, type Nap, noIntent } from "../../src/index.ts"

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

export const counterAcceptors: Acceptors<typeof Model.Type, typeof Proposal.Type> = {
  Inc: (model, proposal) => ({ count: model.count + proposal.by }),
  Reset: () => ({ count: 0 })
}

export const counterNap: Nap<typeof Representation.Type, typeof Intent.Type> = {
  low: noIntent,
  high: () => Option.some({ _tag: "AutoReset" })
}

export const Counter = define({
  name: "counter",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  initial: { count: 0 },
  acceptors: counterAcceptors,
  reactors: [],
  state: (model) => ({ controlState: model.count >= 3 ? "high" : "low", count: model.count }),
  nap: counterNap,
  actions: {
    Inc: (intent) => Effect.succeed({ _tag: "Inc", by: intent.by }),
    Reset: () => Effect.succeed({ _tag: "Reset" }),
    AutoReset: () => Effect.sleep("1 second").pipe(Effect.as({ _tag: "Reset" })),
    Fail: () => Effect.fail(new ActionFailure({ intentTag: "Fail", message: "boom" }))
  }
})

export const Ports = makePorts(Counter)
