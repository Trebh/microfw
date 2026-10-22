import { Effect, Option, Schema } from "effect"
import { define } from "../../src/index.ts"

/** Two independent automatic actions: `ClearA` takes ten seconds, `ClearB` is instant. */
export const Clears = define({
  name: "clears",
  model: Schema.Struct({ a: Schema.Boolean, b: Schema.Boolean }),
  proposal: Schema.Union([
    Schema.TaggedStruct("ArmA", {}),
    Schema.TaggedStruct("ArmB", {}),
    Schema.TaggedStruct("ClearedA", {}),
    Schema.TaggedStruct("ClearedB", {})
  ]),
  intent: Schema.Union([Schema.TaggedStruct("ClearA", {}), Schema.TaggedStruct("ClearB", {})]),
  representation: Schema.Struct({
    controlState: Schema.Literals(["idle", "busy"]),
    a: Schema.Boolean,
    b: Schema.Boolean
  })
})({
  controlStates: ["idle", "busy"],
  initial: { a: false, b: false },
  acceptors: [
    (model, proposal) => (proposal._tag === "ArmA" ? { ...model, a: true } : model),
    (model, proposal) => (proposal._tag === "ArmB" ? { ...model, b: true } : model),
    (model, proposal) => (proposal._tag === "ClearedA" ? { ...model, a: false } : model),
    (model, proposal) => (proposal._tag === "ClearedB" ? { ...model, b: false } : model)
  ],
  reactors: [],
  state: (model) => ({ controlState: model.a || model.b ? "busy" : "idle", a: model.a, b: model.b }),
  nap: (representation) => {
    if (representation.b) return Option.some({ _tag: "ClearB" })
    return representation.a ? Option.some({ _tag: "ClearA" }) : Option.none()
  },
  actions: {
    ClearA: () => Effect.sleep("10 seconds").pipe(Effect.as({ _tag: "ClearedA" })),
    ClearB: () => Effect.succeed({ _tag: "ClearedB" })
  }
})
