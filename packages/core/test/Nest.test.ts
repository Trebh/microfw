import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import {
  ActionFailure,
  applyProposal,
  define,
  intentKeyOf,
  nest,
  noIntent,
  proposalLabel,
  unchanged
} from "../src/index.ts"
import { Counter } from "./fixtures/Counter.ts"
import { NestedCounter } from "./fixtures/NestedCounter.ts"

const Plain = nest(Counter, Counter)

const at = (parent: number, child: number) => ({ parent: { count: parent }, child: { count: child } })

const representationAt = (parent: number, child: number) => Plain.state(at(parent, child))

describe("nest acceptors", () => {
  it("a child proposal changes only the child", () => {
    const next = applyProposal(Plain, at(1, 1), { _tag: "Child", proposal: { _tag: "Inc", by: 2 } })

    assert.deepStrictEqual(next, at(1, 3))
  })

  it("a parent proposal changes only the parent", () => {
    const next = applyProposal(Plain, at(1, 1), { _tag: "Inc", by: 2 })

    assert.deepStrictEqual(next, at(3, 1))
  })

  it("a child reset leaves the parent alone", () => {
    const next = applyProposal(Plain, at(4, 4), { _tag: "Child", proposal: { _tag: "Reset" } })

    assert.deepStrictEqual(next, at(4, 0))
  })
})

describe("nest forwarding", () => {
  it("toChild applies the forwarded proposal in the same step", () => {
    const next = applyProposal(NestedCounter, at(2, 5), { _tag: "Reset" })

    assert.deepStrictEqual(next, at(0, 0))
  })

  it("toChild leaves the child alone for a proposal it does not forward", () => {
    const next = applyProposal(NestedCounter, at(2, 5), { _tag: "Inc", by: 1 })

    assert.deepStrictEqual(next, at(3, 5))
  })

  it("toParent applies the forwarded proposal to the parent in the same step", () => {
    const Mirrored = nest(Counter, Counter, {
      toParent: (proposal) => (proposal._tag === "Inc" ? Option.some(proposal) : Option.none())
    })

    const next = applyProposal(Mirrored, at(1, 1), { _tag: "Child", proposal: { _tag: "Inc", by: 2 } })

    assert.deepStrictEqual(next, at(3, 3))
  })

  it("forwards one hop: a forwarded proposal is not forwarded back", () => {
    const Both = nest(Counter, Counter, {
      toParent: (proposal) => (proposal._tag === "Inc" ? Option.some(proposal) : Option.none()),
      toChild: (proposal) => (proposal._tag === "Inc" ? Option.some(proposal) : Option.none())
    })

    const next = applyProposal(Both, at(0, 0), { _tag: "Inc", by: 1 })

    assert.deepStrictEqual(next, at(1, 1))
  })
})

describe("nest reactors", () => {
  const Clamped = define({
    name: "clamped",
    model: Schema.Struct({ count: Schema.Int }),
    proposal: Schema.TaggedStruct("Add", { by: Schema.Int }),
    intent: Schema.TaggedStruct("Add", { by: Schema.Int }),
    representation: Schema.Struct({ controlState: Schema.Literal("any") })
  })({
    initial: { count: 0 },
    acceptors: { Add: (model, proposal) => ({ count: model.count + proposal.by }) },
    reactors: [(model) => ({ count: Math.min(model.count, 10) })],
    state: () => ({ controlState: "any" }),
    nap: { any: noIntent },
    actions: { Add: (intent) => Effect.succeed({ _tag: "Add", by: intent.by }) }
  })
  const Clamping = nest(Clamped, Counter)

  it("a side's reactor runs on that side's model", () => {
    const next = applyProposal(Clamping, at(0, 0), { _tag: "Add", by: 20 })

    assert.deepStrictEqual(next, at(10, 0))
  })

  it("a side's reactor does not touch the other side", () => {
    const next = applyProposal(Clamping, at(0, 0), { _tag: "Child", proposal: { _tag: "Inc", by: 20 } })

    assert.deepStrictEqual(next, at(0, 20))
  })
})

describe("nest representation", () => {
  it("carries both sides' representations and the parent's control state by default", () => {
    const representation = representationAt(3, 0)

    assert.deepStrictEqual(representation, {
      controlState: "high",
      parent: { controlState: "high", count: 3 },
      child: { controlState: "low", count: 0 }
    })
  })

  it("the default control states are the parent's", () => {
    assert.deepStrictEqual(Plain.controlStates, ["low", "high"])
  })

  it("combines both sides' control states when the option says so", () => {
    const representation = NestedCounter.state(at(0, 3))

    assert.strictEqual(representation.controlState, "low/high")
  })

  it("starts from both sides' initial models", () => {
    assert.deepStrictEqual(Plain.initial, at(0, 0))
  })
})

describe("nest nap", () => {
  it("offers the parent's intent first", () => {
    const intent = Plain.nap(representationAt(3, 3))

    assert.deepStrictEqual(intent, Option.some({ _tag: "AutoReset" }))
  })

  it("offers the child's intent wrapped when the parent has none", () => {
    const intent = Plain.nap(representationAt(0, 3))

    assert.deepStrictEqual(intent, Option.some({ _tag: "Child", intent: { _tag: "AutoReset" } }))
  })

  it("offers nothing when neither side has an intent", () => {
    const intent = Plain.nap(representationAt(1, 1))

    assert.deepStrictEqual(intent, Option.none())
  })
})

describe("nest actions", () => {
  it.effect("a parent intent runs the parent's action", () =>
    Effect.gen(function*() {
      const proposal = yield* Plain.actions.Inc({ _tag: "Inc", by: 2 })

      assert.deepStrictEqual(proposal, { _tag: "Inc", by: 2 })
    }))

  it.effect("a child intent runs the child's action and wraps its proposal", () =>
    Effect.gen(function*() {
      const proposal = yield* Plain.actions.Child({ _tag: "Child", intent: { _tag: "Inc", by: 2 } })

      assert.deepStrictEqual(proposal, { _tag: "Child", proposal: { _tag: "Inc", by: 2 } })
    }))

  it.effect("a child action's failure reaches the caller unchanged", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(Plain.actions.Child({ _tag: "Child", intent: { _tag: "Fail" } }))

      assert.instanceOf(failure, ActionFailure)
      assert.strictEqual(failure.intentTag, "Fail")
    }))
})

describe("nest schemas", () => {
  it("decodes a child proposal through the wrapper", () => {
    const proposal = Schema.decodeUnknownSync(Plain.proposal)({ _tag: "Child", proposal: { _tag: "Reset" } })

    assert.deepStrictEqual(proposal, { _tag: "Child", proposal: { _tag: "Reset" } })
  })

  it("decodes a parent proposal unwrapped", () => {
    const proposal = Schema.decodeUnknownSync(Plain.proposal)({ _tag: "Inc", by: 1 })

    assert.deepStrictEqual(proposal, { _tag: "Inc", by: 1 })
  })

  it("decodes a child intent through the wrapper", () => {
    const intent = Schema.decodeUnknownSync(Plain.intent)({ _tag: "Child", intent: { _tag: "AutoReset" } })

    assert.deepStrictEqual(intent, { _tag: "Child", intent: { _tag: "AutoReset" } })
  })

  it("rejects a representation whose control state the definition does not declare", () => {
    const decode = () =>
      Schema.decodeUnknownSync(NestedCounter.representation)({
        controlState: "low",
        parent: { controlState: "low", count: 0 },
        child: { controlState: "low", count: 0 }
      })

    assert.throws(decode)
  })
})

describe("nest naming and authoring", () => {
  it("names the definition after both sides, so its ports do not collide with theirs", () => {
    assert.strictEqual(Plain.name, "counter/counter")
  })

  it("takes the name from the options when given", () => {
    assert.strictEqual(nest(Counter, Counter, { name: "wizard" }).name, "wizard")
  })

  it("throws when the parent's proposals already have a Child tag", () => {
    const Tagged = define({
      name: "tagged",
      model: Schema.Struct({}),
      proposal: Schema.TaggedStruct("Child", {}),
      intent: Schema.TaggedStruct("Go", {}),
      representation: Schema.Struct({ controlState: Schema.Literal("any") })
    })({
      initial: {},
      acceptors: { Child: unchanged },
      reactors: [],
      state: () => ({ controlState: "any" }),
      nap: { any: noIntent },
      actions: { Go: () => Effect.succeed({ _tag: "Child" }) }
    })

    assert.throws(() => nest(Tagged, Counter), "mufw: nest: tagged already has a \"Child\" proposal or intent tag")
  })

  it("throws when the parent's intents already have a Child tag", () => {
    const Tagged = define({
      name: "tagged-intent",
      model: Schema.Struct({}),
      proposal: Schema.TaggedStruct("Go", {}),
      intent: Schema.TaggedStruct("Child", {}),
      representation: Schema.Struct({ controlState: Schema.Literal("any") })
    })({
      initial: {},
      acceptors: { Go: unchanged },
      reactors: [],
      state: () => ({ controlState: "any" }),
      nap: { any: noIntent },
      actions: { Child: () => Effect.succeed({ _tag: "Go" }) }
    })

    assert.throws(() => nest(Tagged, Counter), "mufw: nest: tagged-intent already has")
  })

  it("throws when the parent's proposals include a class-based Child tag", () => {
    class ChildClass extends Schema.TaggedClass<ChildClass>()("Child", {}) {}
    const Classy = define({
      name: "classy",
      model: Schema.Struct({}),
      proposal: Schema.Union([ChildClass, Schema.TaggedStruct("Go", {})]),
      intent: Schema.TaggedStruct("Go", {}),
      representation: Schema.Struct({ controlState: Schema.Literal("any") })
    })({
      initial: {},
      acceptors: { Child: unchanged, Go: unchanged },
      reactors: [],
      state: () => ({ controlState: "any" }),
      nap: { any: noIntent },
      actions: { Go: () => Effect.succeed(new ChildClass({})) }
    })

    assert.throws(() => nest(Classy, Counter), "mufw: nest: classy already has a \"Child\" proposal or intent tag")
  })
})

describe("nest of a nested definition", () => {
  it("routes a grandchild proposal through two Child wrappers", () => {
    const Deep = nest(Counter, Plain)
    const model = { parent: { count: 0 }, child: at(0, 0) }

    const next = applyProposal(Deep, model, { _tag: "Child", proposal: { _tag: "Child", proposal: { _tag: "Inc", by: 2 } } })

    assert.deepStrictEqual(next, { parent: { count: 0 }, child: at(0, 2) })
  })

  it("throws when a nested definition is the parent, because it already has a Child tag", () => {
    assert.throws(() => nest(Plain, Counter), "mufw: nest: counter/counter already has")
  })
})

describe("nest intent keys", () => {
  it("keys a parent intent by its own tag", () => {
    assert.strictEqual(intentKeyOf(Plain, { _tag: "Inc" }), "Inc")
  })

  it("keys a child intent under Child and the child's tag", () => {
    const intent = { _tag: "Child", intent: { _tag: "AutoReset" } }

    assert.strictEqual(intentKeyOf(Plain, intent), "Child/AutoReset")
  })

  it("keys a grandchild intent through both wrappers", () => {
    const Deep = nest(Counter, Plain)
    const intent = { _tag: "Child", intent: { _tag: "Child", intent: { _tag: "AutoReset" } } }

    assert.strictEqual(intentKeyOf(Deep, intent), "Child/Child/AutoReset")
  })
})

describe("proposalLabel", () => {
  it("is the tag of a parent proposal", () => {
    assert.strictEqual(proposalLabel({ _tag: "Inc" }), "Inc")
  })

  it("prefixes a child proposal with Child/", () => {
    const child = { _tag: "Child", proposal: { _tag: "Inc" } }

    assert.strictEqual(proposalLabel(child), "Child/Inc")
  })

  it("follows nested children to the innermost tag", () => {
    const grandchild = { _tag: "Child", proposal: { _tag: "Child", proposal: { _tag: "Reset" } } }

    assert.strictEqual(proposalLabel(grandchild), "Child/Child/Reset")
  })

  it("is Child for a proposal named Child whose payload is null", () => {
    const plain = { _tag: "Child", proposal: null }

    assert.strictEqual(proposalLabel(plain), "Child")
  })

  it("is Child for a proposal named Child whose payload is a string", () => {
    const plain = { _tag: "Child", proposal: "raise" }

    assert.strictEqual(proposalLabel(plain), "Child")
  })
})
