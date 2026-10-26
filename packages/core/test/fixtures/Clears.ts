import { Effect, Option, Schema } from "effect"
import { define, noIntent } from "../../src/index.ts"

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
  initial: { a: false, b: false },
  acceptors: {
    ArmA: (model) => ({ ...model, a: true }),
    ArmB: (model) => ({ ...model, b: true }),
    ClearedA: (model) => ({ ...model, a: false }),
    ClearedB: (model) => ({ ...model, b: false })
  },
  reactors: [],
  state: (model) => ({ controlState: model.a || model.b ? "busy" : "idle", a: model.a, b: model.b }),
  nap: {
    idle: noIntent,
    busy: (representation) => Option.some({ _tag: representation.b ? "ClearB" : "ClearA" })
  },
  actions: {
    ClearA: () => Effect.sleep("10 seconds").pipe(Effect.as({ _tag: "ClearedA" })),
    ClearB: () => Effect.succeed({ _tag: "ClearedB" })
  }
})
