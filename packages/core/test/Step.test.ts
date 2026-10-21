import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { applyProposal, define } from "../src/index.ts"

const Traced = define({
  name: "traced",
  model: Schema.Struct({ trace: Schema.Array(Schema.String) }),
  proposal: Schema.Union([Schema.TaggedStruct("Mark", {}), Schema.TaggedStruct("Unknown", {})]),
  intent: Schema.TaggedStruct("Mark", {}),
  representation: Schema.Struct({ controlState: Schema.Literal("any") })
})({
  controlStates: ["any"],
  initial: { trace: [] },
  acceptors: [
    (model, proposal) => (proposal._tag === "Mark" ? { trace: [...model.trace, "first acceptor"] } : model),
    (model, proposal) => (proposal._tag === "Mark" ? { trace: [...model.trace, "second acceptor"] } : model)
  ],
  reactors: [
    (model) => (model.trace.at(-1) === "second acceptor" ? { trace: [...model.trace, "reactor"] } : model)
  ],
  state: () => ({ controlState: "any" }),
  nap: () => Option.none(),
  actions: { Mark: () => Effect.succeed({ _tag: "Mark" }) }
})

describe("applyProposal", () => {
  it("runs the acceptors in declared order, then the reactors", () => {
    const next = applyProposal(Traced, { trace: [] }, { _tag: "Mark" })

    expect(next).toEqual({ trace: ["first acceptor", "second acceptor", "reactor"] })
  })

  it("leaves the model unchanged for a proposal no acceptor handles", () => {
    const model = { trace: ["before"] }

    const next = applyProposal(Traced, model, { _tag: "Unknown" })

    expect(next).toEqual({ trace: ["before"] })
  })
})
