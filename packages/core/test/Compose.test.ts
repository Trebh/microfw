import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import {
  ActionFailure,
  applyProposal,
  compose,
  define,
  exploreGraph,
  intentKeyOf,
  nest,
  noIntent,
  proposalLabel,
  toXStateDefinition
} from "../src/index.ts"
import { Counter } from "./fixtures/Counter.ts"
import { CounterRows, exploreRows } from "./fixtures/CounterRows.ts"
import { Duo, exploreDuo } from "./fixtures/Duo.ts"
import { Roster } from "./fixtures/Roster.ts"
import { Tally } from "./fixtures/Tally.ts"

const duoAt = (total: number, left: number, right: number) => ({
  parent: { total },
  parts: { Left: { count: left }, Right: { count: right } }
})

const rowsAt = (ids: ReadonlyArray<string>, rows: ReadonlyArray<readonly [string, number]>) => ({
  parent: { ids },
  parts: { Rows: rows.map(([key, count]) => ({ key, model: { count } })) }
})

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

const exploreByModel = { serialize: (_: unknown, model: unknown) => JSON.stringify(model) }

describe("compose routing", () => {
  it("a proposal to one slot leaves the other slot and the parent untouched", () => {
    const next = applyProposal(Duo, duoAt(0, 1, 1), { _tag: "Right", proposal: { _tag: "Inc", by: 2 } })

    assert.deepStrictEqual(next, duoAt(0, 1, 3))
  })

  it("a parent proposal changes only the parent", () => {
    const next = applyProposal(Duo, duoAt(0, 1, 1), { _tag: "Bumped", by: 2 })

    assert.deepStrictEqual(next, duoAt(2, 1, 1))
  })

  it("a collection proposal reaches only the instance with its key", () => {
    const model = rowsAt(["a", "b"], [["a", 1], ["b", 2]])

    const next = applyProposal(CounterRows, model, { _tag: "Rows", key: "b", proposal: { _tag: "Inc", by: 3 } })

    assert.deepStrictEqual(next, rowsAt(["a", "b"], [["a", 1], ["b", 5]]))
  })

  it("a proposal for a key the collection does not hold changes nothing", () => {
    const model = rowsAt(["a"], [["a", 1]])

    const next = applyProposal(CounterRows, model, { _tag: "Rows", key: "z", proposal: { _tag: "Inc", by: 3 } })

    assert.deepStrictEqual(next, rowsAt(["a"], [["a", 1]]))
  })
})

describe("compose collection lifecycle", () => {
  it("a new id creates an instance with the model `create` returns for the parent's new model", () => {
    const next = applyProposal(CounterRows, rowsAt([], []), { _tag: "Added", id: "a" })

    assert.deepStrictEqual(next, rowsAt(["a"], [["a", 1]]))
  })

  it("a new id leaves the instances already held as they are", () => {
    const next = applyProposal(CounterRows, rowsAt(["a"], [["a", 5]]), { _tag: "Added", id: "b" })

    assert.deepStrictEqual(next, rowsAt(["a", "b"], [["a", 5], ["b", 2]]))
  })

  it("a removed id drops its instance", () => {
    const model = rowsAt(["a", "b"], [["a", 1], ["b", 2]])

    const next = applyProposal(CounterRows, model, { _tag: "Removed", id: "a" })

    assert.deepStrictEqual(next, rowsAt(["b"], [["b", 2]]))
  })

  it("instances follow the order of the keys", () => {
    const model = rowsAt(["b", "a"], [["a", 1], ["b", 2]])

    const next = applyProposal(CounterRows, model, { _tag: "Added", id: "a" })

    assert.deepStrictEqual(next, rowsAt(["b", "a"], [["b", 2], ["a", 1]]))
  })

  it("a repeated key counts once", () => {
    const Repeated = compose(Roster, (part) => ({
      Rows: part.collection(Counter, { keys: (roster) => [...roster.ids, ...roster.ids] })
    }))

    const next = applyProposal(Repeated, rowsAt([], []), { _tag: "Added", id: "a" })

    assert.deepStrictEqual(next, rowsAt(["a"], [["a", 0]]))
  })

  it("the initial model holds the instances the parent's initial model lists", () => {
    const Seeded = define({
      name: "seeded",
      model: Schema.Struct({ ids: Schema.Array(Schema.String) }),
      proposal: Schema.TaggedStruct("Kept", {}),
      intent: Schema.TaggedStruct("Keep", {}),
      representation: Schema.Struct({ controlState: Schema.Literal("any") })
    })({
      initial: { ids: ["x", "y"] },
      acceptors: { Kept: (model) => model },
      reactors: [],
      state: () => ({ controlState: "any" }),
      nap: { any: noIntent },
      actions: { Keep: () => Effect.succeed({ _tag: "Kept" }) }
    })
    const Preset = compose(Seeded, (part) => ({
      Rows: part.collection(Counter, {
        keys: (parent) => parent.ids,
        create: (_, parent) => ({ count: parent.ids.length })
      })
    }))

    assert.deepStrictEqual(Preset.initial, {
      parent: { ids: ["x", "y"] },
      parts: { Rows: [{ key: "x", model: { count: 2 } }, { key: "y", model: { count: 2 } }] }
    })
  })

  it("the initial model has no instance when the parent lists none", () => {
    assert.deepStrictEqual(CounterRows.initial, rowsAt([], []))
  })
})

describe("compose forwarding", () => {
  it("a slot's toParent applies the forwarded proposal to the parent in the same step", () => {
    const next = applyProposal(Duo, duoAt(1, 0, 0), { _tag: "Left", proposal: { _tag: "Inc", by: 2 } })

    assert.deepStrictEqual(next, duoAt(3, 2, 0))
  })

  it("a slot's toParent leaves the parent alone for a proposal it does not forward", () => {
    const next = applyProposal(Duo, duoAt(1, 2, 0), { _tag: "Left", proposal: { _tag: "Reset" } })

    assert.deepStrictEqual(next, duoAt(1, 0, 0))
  })

  it("a slot's fromParent applies the forwarded proposal to that slot only", () => {
    const next = applyProposal(Duo, duoAt(4, 3, 3), { _tag: "Zeroed" })

    assert.deepStrictEqual(next, duoAt(0, 0, 3))
  })

  it("a collection's toParent receives the key of the instance", () => {
    const Reporting = compose(Roster, (part) => ({
      Rows: part.collection(Counter, {
        keys: (roster) => roster.ids,
        toParent: (proposal, key) =>
          proposal._tag === "Inc" ? Option.some({ _tag: "Added", id: `${key}-seen` } as const) : Option.none()
      })
    }))

    const next = applyProposal(Reporting, rowsAt(["a"], [["a", 0]]), {
      _tag: "Rows",
      key: "a",
      proposal: { _tag: "Inc", by: 1 }
    })

    assert.deepStrictEqual(next.parent, { ids: ["a", "a-seen"] })
  })

  it("a proposal for a key the collection does not hold is not forwarded to the parent", () => {
    const Reporting = compose(Roster, (part) => ({
      Rows: part.collection(Counter, {
        keys: (roster) => roster.ids,
        toParent: (_, key) => Option.some({ _tag: "Added", id: `${key}-seen` } as const)
      })
    }))

    const next = applyProposal(Reporting, rowsAt(["a"], [["a", 0]]), {
      _tag: "Rows",
      key: "z",
      proposal: { _tag: "Inc", by: 1 }
    })

    assert.deepStrictEqual(next.parent, { ids: ["a"] })
  })

  const Broadcast = compose(Roster, (part) => ({
    Rows: part.collection(Counter, {
      keys: (roster) => roster.ids,
      fromParent: (proposal) => proposal._tag === "Added" ? Option.some({ _tag: "Inc", by: 1 } as const) : Option.none()
    })
  }))

  it("a collection's fromParent applies the forwarded proposal to every instance in one applyProposal", () => {
    const model = rowsAt(["a", "b"], [["a", 1], ["b", 2]])

    const next = applyProposal(Broadcast, model, { _tag: "Added", id: "a" })

    assert.deepStrictEqual(next, rowsAt(["a", "b"], [["a", 2], ["b", 3]]))
  })

  it("an instance created by a proposal does not receive that proposal", () => {
    const next = applyProposal(Broadcast, rowsAt(["a"], [["a", 1]]), { _tag: "Added", id: "b" })

    assert.deepStrictEqual(next, rowsAt(["a", "b"], [["a", 2], ["b", 0]]))
  })

  it("a collection's fromParent receives the key of each instance", () => {
    const OnlyB = compose(Roster, (part) => ({
      Rows: part.collection(Counter, {
        keys: (roster) => roster.ids,
        fromParent: (_, key) => key === "b" ? Option.some({ _tag: "Inc", by: 1 } as const) : Option.none()
      })
    }))
    const model = rowsAt(["a", "b"], [["a", 1], ["b", 2]])

    const next = applyProposal(OnlyB, model, { _tag: "Added", id: "a" })

    assert.deepStrictEqual(next, rowsAt(["a", "b"], [["a", 1], ["b", 3]]))
  })

  const Echo = compose(Tally, (part) => ({
    Left: part.slot(Counter, {
      toParent: (proposal) => proposal._tag === "Inc" ? Option.some({ _tag: "Bumped", by: proposal.by } as const) : Option.none(),
      fromParent: (proposal) => proposal._tag === "Bumped" ? Option.some({ _tag: "Inc", by: proposal.by } as const) : Option.none()
    })
  }))

  it("a proposal forwarded to the parent is not forwarded back to the part", () => {
    const model = { parent: { total: 0 }, parts: { Left: { count: 0 } } }

    const next = applyProposal(Echo, model, { _tag: "Left", proposal: { _tag: "Inc", by: 1 } })

    assert.deepStrictEqual(next, { parent: { total: 1 }, parts: { Left: { count: 1 } } })
  })

  it("a proposal forwarded to a part is not forwarded back to the parent", () => {
    const model = { parent: { total: 0 }, parts: { Left: { count: 0 } } }

    const next = applyProposal(Echo, model, { _tag: "Bumped", by: 2 })

    assert.deepStrictEqual(next, { parent: { total: 2 }, parts: { Left: { count: 2 } } })
  })

  it("a proposal forwarded to the parent is not forwarded on to a sibling part", () => {
    const Relay = compose(Tally, (part) => ({
      Left: part.slot(Counter, {
        toParent: (proposal) => proposal._tag === "Inc" ? Option.some({ _tag: "Bumped", by: proposal.by } as const) : Option.none()
      }),
      Right: part.slot(Counter, {
        fromParent: (proposal) => proposal._tag === "Bumped" ? Option.some({ _tag: "Inc", by: proposal.by } as const) : Option.none()
      })
    }))
    const model = { parent: { total: 0 }, parts: { Left: { count: 0 }, Right: { count: 0 } } }

    const next = applyProposal(Relay, model, { _tag: "Left", proposal: { _tag: "Inc", by: 1 } })

    assert.deepStrictEqual(next, { parent: { total: 1 }, parts: { Left: { count: 1 }, Right: { count: 0 } } })
  })
})

describe("compose reactors", () => {
  const Clamping = compose(Counter, (part) => ({
    Clamp: part.slot(Clamped),
    Rows: part.collection(Clamped, { keys: () => ["a", "b"] })
  }))
  const clampingAt = (parent: number, clamp: number, a: number, b: number) => ({
    parent: { count: parent },
    parts: { Clamp: { count: clamp }, Rows: [{ key: "a", model: { count: a } }, { key: "b", model: { count: b } }] }
  })

  it("a slot's reactor runs on that slot's model", () => {
    const next = applyProposal(Clamping, clampingAt(0, 0, 0, 0), { _tag: "Clamp", proposal: { _tag: "Add", by: 20 } })

    assert.deepStrictEqual(next, clampingAt(0, 10, 0, 0))
  })

  it("a slot's reactor does not touch the parent", () => {
    const next = applyProposal(Clamping, clampingAt(0, 0, 0, 0), { _tag: "Inc", by: 20 })

    assert.deepStrictEqual(next, clampingAt(20, 0, 0, 0))
  })

  it("a collection's reactor runs on each instance's own model", () => {
    const next = applyProposal(Clamping, clampingAt(0, 0, 8, 8), { _tag: "Rows", key: "a", proposal: { _tag: "Add", by: 20 } })

    assert.deepStrictEqual(next, clampingAt(0, 0, 10, 8))
  })

  it("the parent's reactor runs on the parent's model", () => {
    const ClampedParent = compose(Clamped, (part) => ({ Side: part.slot(Counter) }))
    const model = { parent: { count: 0 }, parts: { Side: { count: 0 } } }

    const next = applyProposal(ClampedParent, model, { _tag: "Add", by: 20 })

    assert.deepStrictEqual(next, { parent: { count: 10 }, parts: { Side: { count: 0 } } })
  })
})

describe("compose representation", () => {
  it("carries the parent's and every instance's representation beside the composite's control state", () => {
    const representation = CounterRows.state(rowsAt(["a"], [["a", 1]]))

    assert.deepStrictEqual(representation, {
      controlState: "listed",
      parent: { controlState: "listed", ids: ["a"] },
      parts: { Rows: [{ key: "a", representation: { controlState: "low", count: 1 } }] }
    })
  })

  it("the default control states are the parent's", () => {
    const Plain = compose(Roster, (part) => ({ Rows: part.collection(Counter, { keys: (roster) => roster.ids }) }))

    assert.deepStrictEqual(Plain.controlStates, ["empty", "listed"])
  })

  it("the default control state is the parent's", () => {
    const Plain = compose(Roster, (part) => ({ Rows: part.collection(Counter, { keys: (roster) => roster.ids }) }))

    assert.strictEqual(Plain.state(rowsAt(["a"], [["a", 3]])).controlState, "listed")
  })

  it("an instance can take the control state of the composite", () => {
    assert.strictEqual(CounterRows.state(rowsAt(["a", "b"], [["a", 0], ["b", 3]])).controlState, "busy")
  })

  it("combines the control states when the option says so", () => {
    assert.strictEqual(Duo.state(duoAt(0, 0, 3)).controlState, "low/high")
  })

  it("starts from the parent's and every slot's initial model", () => {
    assert.deepStrictEqual(Duo.initial, duoAt(0, 0, 0))
  })

  it("rejects a representation whose control state the definition does not declare", () => {
    const decode = () =>
      Schema.decodeUnknownSync(Duo.representation)({
        controlState: "low",
        parent: { controlState: "counting", total: 0 },
        parts: {
          Left: { controlState: "low", count: 0 },
          Right: { controlState: "low", count: 0 }
        }
      })

    assert.throws(decode)
  })
})

describe("compose nap", () => {
  const Mixed = compose(Counter, (part) => ({
    Left: part.slot(Counter),
    Rows: part.collection(Counter, { keys: () => ["a", "b"] })
  }))
  const mixedAt = (parent: number, left: number, a: number, b: number) => ({
    parent: { count: parent },
    parts: { Left: { count: left }, Rows: [{ key: "a", model: { count: a } }, { key: "b", model: { count: b } }] }
  })

  it("offers the parent's intent, then each part's in the order the parts are declared, a collection's instances in collection order", () => {
    const intents = Mixed.nap(Mixed.state(mixedAt(3, 3, 3, 3)))

    assert.deepStrictEqual(intents, [
      { _tag: "AutoReset" },
      { _tag: "Left", intent: { _tag: "AutoReset" } },
      { _tag: "Rows", key: "a", intent: { _tag: "AutoReset" } },
      { _tag: "Rows", key: "b", intent: { _tag: "AutoReset" } }
    ])
  })

  it("offers a collection's instances before a slot's when the collection is declared first", () => {
    const Reversed = compose(Counter, (part) => ({
      Rows: part.collection(Counter, { keys: () => ["a", "b"] }),
      Left: part.slot(Counter)
    }))
    const model = {
      parent: { count: 3 },
      parts: { Rows: [{ key: "a", model: { count: 3 } }, { key: "b", model: { count: 3 } }], Left: { count: 3 } }
    }

    const intents = Reversed.nap(Reversed.state(model))

    assert.deepStrictEqual(intents, [
      { _tag: "AutoReset" },
      { _tag: "Rows", key: "a", intent: { _tag: "AutoReset" } },
      { _tag: "Rows", key: "b", intent: { _tag: "AutoReset" } },
      { _tag: "Left", intent: { _tag: "AutoReset" } }
    ])
  })

  it("offers only the instances that have an intent", () => {
    const intents = Mixed.nap(Mixed.state(mixedAt(0, 0, 0, 3)))

    assert.deepStrictEqual(intents, [{ _tag: "Rows", key: "b", intent: { _tag: "AutoReset" } }])
  })

  it("offers nothing when no part has an intent", () => {
    const intents = Mixed.nap(Mixed.state(mixedAt(0, 0, 0, 0)))

    assert.deepStrictEqual(intents, [])
  })
})

describe("compose intent keys and labels", () => {
  it("keys a parent intent by its own tag", () => {
    assert.strictEqual(intentKeyOf(CounterRows, { _tag: "Add" }), "Add")
  })

  it("keys a slot's intent under its name and the child's tag", () => {
    const intent = { _tag: "Left", intent: { _tag: "AutoReset" } }

    assert.strictEqual(intentKeyOf(Duo, intent), "Left/AutoReset")
  })

  it("keys an instance's intent under the part, its key and the child's tag", () => {
    const intent = { _tag: "Rows", key: "b", intent: { _tag: "AutoReset" } }

    assert.strictEqual(intentKeyOf(CounterRows, intent), "Rows[b]/AutoReset")
  })

  it("labels a parent proposal by its tag", () => {
    const proposal = { _tag: "Added", id: "a" }

    assert.strictEqual(proposalLabel(CounterRows, proposal), "Added")
  })

  it("labels a slot's proposal under its name", () => {
    const proposal = { _tag: "Left", proposal: { _tag: "Inc", by: 1 } }

    assert.strictEqual(proposalLabel(Duo, proposal), "Left/Inc")
  })

  it("labels an instance's proposal under the part and its key", () => {
    const proposal = { _tag: "Rows", key: "b", proposal: { _tag: "Inc", by: 1 } }

    assert.strictEqual(proposalLabel(CounterRows, proposal), "Rows[b]/Inc")
  })
})

describe("compose actions", () => {
  it.effect("a parent intent runs the parent's action", () =>
    Effect.gen(function*() {
      const proposal = yield* Duo.actions.Bump({ _tag: "Bump", by: 2 })

      assert.deepStrictEqual(proposal, { _tag: "Bumped", by: 2 })
    }))

  it.effect("a slot's intent runs the child's action and wraps its proposal", () =>
    Effect.gen(function*() {
      const proposal = yield* Duo.actions.Left({ _tag: "Left", intent: { _tag: "Inc", by: 2 } })

      assert.deepStrictEqual(proposal, { _tag: "Left", proposal: { _tag: "Inc", by: 2 } })
    }))

  it.effect("an instance's intent runs the child's action and wraps its proposal with the key", () =>
    Effect.gen(function*() {
      const proposal = yield* CounterRows.actions.Rows({ _tag: "Rows", key: "b", intent: { _tag: "Inc", by: 2 } })

      assert.deepStrictEqual(proposal, { _tag: "Rows", key: "b", proposal: { _tag: "Inc", by: 2 } })
    }))

  it.effect("a child action's failure reaches the caller unchanged", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(CounterRows.actions.Rows({ _tag: "Rows", key: "b", intent: { _tag: "Fail" } }))

      assert.instanceOf(failure, ActionFailure)
      assert.strictEqual(failure.intentTag, "Fail")
    }))
})

describe("compose schemas", () => {
  it("decodes an instance's proposal with its key", () => {
    const proposal = Schema.decodeUnknownSync(CounterRows.proposal)({
      _tag: "Rows",
      key: "a",
      proposal: { _tag: "Reset" }
    })

    assert.deepStrictEqual(proposal, { _tag: "Rows", key: "a", proposal: { _tag: "Reset" } })
  })

  it("rejects an instance's proposal without a key", () => {
    const decode = () => Schema.decodeUnknownSync(CounterRows.proposal)({ _tag: "Rows", proposal: { _tag: "Reset" } })

    assert.throws(decode)
  })

  it("decodes a slot's intent through its wrapper", () => {
    const intent = Schema.decodeUnknownSync(Duo.intent)({ _tag: "Right", intent: { _tag: "AutoReset" } })

    assert.deepStrictEqual(intent, { _tag: "Right", intent: { _tag: "AutoReset" } })
  })

  it("decodes a parent proposal unwrapped", () => {
    const proposal = Schema.decodeUnknownSync(Duo.proposal)({ _tag: "Zeroed" })

    assert.deepStrictEqual(proposal, { _tag: "Zeroed" })
  })

  it("decodes a model with its instances", () => {
    const model = Schema.decodeUnknownSync(CounterRows.model)(rowsAt(["a", "b"], [["a", 1], ["b", 2]]))

    assert.deepStrictEqual(model, rowsAt(["a", "b"], [["a", 1], ["b", 2]]))
  })
})

describe("compose naming and authoring", () => {
  it("names the definition after the parent and its parts", () => {
    assert.strictEqual(Duo.name, "tally/Left+Right")
  })

  it("takes the name from the options when given", () => {
    const Named = compose(Tally, (part) => ({ Left: part.slot(Counter) }), { name: "dashboard" })

    assert.strictEqual(Named.name, "dashboard")
  })

  it("throws when a part is named like a proposal tag of the parent", () => {
    const clash = () => compose(Roster, (part) => ({ Added: part.slot(Counter) }))

    assert.throws(clash, "mufw: compose: roster already has a \"Added\" proposal or intent tag")
  })

  it("throws when a part is named like an intent tag of the parent", () => {
    const clash = () => compose(Roster, (part) => ({ Add: part.slot(Counter) }))

    assert.throws(clash, "mufw: compose: roster already has a \"Add\" proposal or intent tag")
  })

  it("throws when a part name is not PascalCase", () => {
    const lowercase = () => compose(Roster, (part) => ({ rows: part.slot(Counter) }))

    assert.throws(lowercase, "mufw: compose: \"rows\" is not a PascalCase part name")
  })

  it("throws when a part is named like the Child tag of a nested parent", () => {
    const clash = () => compose(nest(Counter, Counter), (part) => ({ Child: part.slot(Counter) }))

    assert.throws(clash, "mufw: compose: counter/counter already has a \"Child\" proposal or intent tag")
  })
})

describe("compose of composed definitions", () => {
  it("a composed definition is the parent of another compose", () => {
    const Extended = compose(Duo, (part) => ({ Extra: part.slot(Counter) }))
    const model = { parent: duoAt(0, 0, 0), parts: { Extra: { count: 0 } } }

    const next = applyProposal(Extended, model, { _tag: "Left", proposal: { _tag: "Inc", by: 2 } })

    assert.deepStrictEqual(next, { parent: duoAt(2, 2, 0), parts: { Extra: { count: 0 } } })
  })

  it("a composed definition is a slot's child in another compose", () => {
    const Paired = compose(Roster, (part) => ({ Pair: part.slot(Duo) }))
    const model = { parent: { ids: [] }, parts: { Pair: duoAt(0, 0, 0) } }

    const next = applyProposal(Paired, model, {
      _tag: "Pair",
      proposal: { _tag: "Left", proposal: { _tag: "Inc", by: 2 } }
    })

    assert.deepStrictEqual(next, { parent: { ids: [] }, parts: { Pair: duoAt(2, 2, 0) } })
  })

  it("a composed child's label and intent key keep its own wrapper", () => {
    const Paired = compose(Roster, (part) => ({ Pair: part.slot(Duo) }))
    const proposal = { _tag: "Pair", proposal: { _tag: "Left", proposal: { _tag: "Inc", by: 1 } } }
    const intent = { _tag: "Pair", intent: { _tag: "Left", intent: { _tag: "AutoReset" } } }

    assert.deepStrictEqual(
      [proposalLabel(Paired, proposal), intentKeyOf(Paired, intent)],
      ["Pair/Left/Inc", "Pair/Left/AutoReset"]
    )
  })

  it("a composed definition is the parent of a nest", () => {
    const Nested = nest(Duo, Counter)
    const model = { parent: duoAt(0, 0, 0), child: { count: 0 } }

    const next = applyProposal(Nested, model, { _tag: "Left", proposal: { _tag: "Inc", by: 2 } })

    assert.deepStrictEqual(next, { parent: duoAt(2, 2, 0), child: { count: 0 } })
  })

  it("a nested definition is a slot's child, and its label keeps the Child prefix", () => {
    const Wizard = compose(Roster, (part) => ({ Wizard: part.slot(nest(Counter, Counter)) }))
    const proposal = { _tag: "Wizard", proposal: { _tag: "Child", proposal: { _tag: "Inc", by: 1 } } }

    assert.strictEqual(proposalLabel(Wizard, proposal), "Wizard/Child/Inc")
  })
})

describe("compose graph", () => {
  it("explores two slots within the default limit, one node per combined control state", () => {
    const graph = exploreGraph(Duo, exploreDuo, exploreByModel)

    assert.deepStrictEqual([...graph.nodes.keys()].sort(), ["high/high", "high/low", "low/high", "low/low"])
  })

  it("explores a collection of at most two rows within the default limit, one node per composite control state", () => {
    const graph = exploreGraph(CounterRows, exploreRows, exploreByModel)

    assert.deepStrictEqual([...graph.nodes.keys()].sort(), ["busy", "empty", "listed"])
  })

  it("names an XState event after the instance the proposal addressed", () => {
    const graph = exploreGraph(CounterRows, exploreRows, exploreByModel)

    const machine = toXStateDefinition(CounterRows, graph)

    assert.strictEqual(machine.states.listed?.on["Rows[a]/Inc"], "busy")
  })
})
