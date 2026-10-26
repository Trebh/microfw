import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { applyProposal, define, noIntent, unchanged } from "../src/index.ts"

const Traced = define({
  name: "traced",
  model: Schema.Struct({ trace: Schema.Array(Schema.String) }),
  proposal: Schema.Union([
    Schema.TaggedStruct("Marked", {}),
    Schema.TaggedStruct("Noted", {}),
    Schema.TaggedStruct("Ignored", {})
  ]),
  intent: Schema.TaggedStruct("Mark", {}),
  representation: Schema.Struct({ controlState: Schema.Literals(["settled", "marked"]) })
})({
  initial: { trace: [] },
  acceptors: {
    Marked: (model) => ({ trace: [...model.trace, "marked acceptor"] }),
    Noted: (model) => ({ trace: [...model.trace, "noted acceptor"] }),
    Ignored: unchanged
  },
  reactors: [
    (model) => (model.trace.at(-1) === "marked acceptor" ? { trace: [...model.trace, "reactor"] } : model)
  ],
  state: (model) => ({ controlState: model.trace.length === 0 ? "settled" : "marked" }),
  nap: {
    settled: noIntent,
    marked: () => Option.some({ _tag: "Mark" })
  },
  actions: { Mark: () => Effect.succeed({ _tag: "Marked" }) }
})

describe("applyProposal", () => {
  it("runs the acceptor of the proposal's tag, then the reactors", () => {
    const next = applyProposal(Traced, { trace: [] }, { _tag: "Marked" })

    expect(next).toEqual({ trace: ["marked acceptor", "reactor"] })
  })

  it("runs no acceptor of another tag", () => {
    const next = applyProposal(Traced, { trace: [] }, { _tag: "Noted" })

    expect(next).toEqual({ trace: ["noted acceptor"] })
  })

  it("leaves the model unchanged for a tag set as unchanged", () => {
    const model = { trace: ["before"] }

    const next = applyProposal(Traced, model, { _tag: "Ignored" })

    expect(next).toBe(model)
  })
})

describe("define", () => {
  it("derives the control states from the nap keys, in key order", () => {
    expect(Traced.controlStates).toEqual(["settled", "marked"])
  })

  it("naps with the entry of the representation's control state", () => {
    const settled = Traced.nap({ controlState: "settled" })
    const marked = Traced.nap({ controlState: "marked" })

    expect(settled).toEqual(Option.none())
    expect(marked).toEqual(Option.some({ _tag: "Mark" }))
  })
})
