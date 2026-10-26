import { assert, describe, it } from "@effect/vitest"
import {
  type AnyDefinition,
  AutoActions,
  type IntentOf,
  layerLoopLocal,
  type Path,
  type PathStep,
  type ProposalOf,
  type RepresentationOf
} from "@mufw/core"
import { makeRpc } from "@mufw/rpc"
import { Effect, Layer } from "effect"
import type { Counter } from "../../core/test/fixtures/Counter.ts"
import { CounterRows, exploreRows, RowsPorts } from "../../core/test/fixtures/CounterRows.ts"
import { Duo, DuoPorts, exploreDuo } from "../../core/test/fixtures/Duo.ts"
import { createTestModel, intentDriver } from "../src/index.ts"

// Exploration tells states apart by their model, since the control state alone would expand one
// state per node. `simplePaths` is left out: it enumerates every non-repeating path of the state
// graph, which grows combinatorially with the number of states.
const byModel = { serialize: (_: unknown, model: unknown) => JSON.stringify(model) }

const named = <D extends AnyDefinition>(
  model: { readonly describe: (path: Path<D>) => string },
  paths: ReadonlyArray<Path<D>>
) => paths.map((path) => ({ name: model.describe(path), path }))

const Auto = Layer.succeed(AutoActions, false)

const DuoLocal = layerLoopLocal(Duo, DuoPorts).pipe(Layer.provide(Auto))
const DuoRpc = makeRpc(Duo, DuoPorts)
const DuoRemote = Layer.mergeAll(DuoRpc.layerModelRemote, DuoRpc.layerHistoryRemote, DuoRpc.layerIntentPortRemote).pipe(
  Layer.provide(DuoRpc.layerClientTest),
  Layer.provide(DuoRpc.layerHandlers),
  Layer.provide(DuoLocal)
)

const duo = createTestModel(Duo, DuoPorts, {
  ...byModel,
  explore: exploreDuo,
  states: {
    "low/low": (r) => assert.deepStrictEqual([r.parts.Left.count < 3, r.parts.Right.count < 3], [true, true]),
    "low/high": (r) => assert.deepStrictEqual([r.parts.Left.count < 3, r.parts.Right.count >= 3], [true, true]),
    "high/low": (r) => assert.deepStrictEqual([r.parts.Left.count >= 3, r.parts.Right.count < 3], [true, true]),
    "high/high": (r) => assert.deepStrictEqual([r.parts.Left.count >= 3, r.parts.Right.count >= 3], [true, true])
  }
})

const counterIntentFor = (proposal: ProposalOf<typeof Counter>): IntentOf<typeof Counter> => {
  switch (proposal._tag) {
    case "Inc":
      return { _tag: "Inc", by: proposal.by }
    case "Reset":
      return { _tag: "Reset" }
  }
}

const duoIntentFor = (step: PathStep<typeof Duo>): IntentOf<typeof Duo> => {
  const proposal = step.proposal
  switch (proposal._tag) {
    case "Bumped":
      return { _tag: "Bump", by: proposal.by }
    case "Zeroed":
      return { _tag: "Zero" }
    case "Left":
      return { _tag: "Left", intent: counterIntentFor(proposal.proposal) }
    case "Right":
      return { _tag: "Right", intent: counterIntentFor(proposal.proposal) }
  }
}

describe("two counters under a tally, local loop", () => {
  it.effect.each(named(duo, duo.shortestPaths()))("shortest: $name", ({ path }) =>
    duo.run(path).pipe(Effect.provide(DuoLocal)))
  it.effect.each(named(duo, duo.shortestPaths()))("through the actions: $name", ({ path }) =>
    duo.run(path, intentDriver(DuoPorts, duoIntentFor)).pipe(Effect.provide(DuoLocal)))
})

describe("two counters under a tally, Rpc.layerClientTest", () => {
  it.effect.each(named(duo, duo.shortestPaths()))("shortest: $name", ({ path }) =>
    duo.run(path).pipe(Effect.provide(DuoRemote)))
  it.effect.each(named(duo, duo.shortestPaths()))("through the actions: $name", ({ path }) =>
    duo.run(path, intentDriver(DuoPorts, duoIntentFor)).pipe(Effect.provide(DuoRemote)))
})

const RowsLocal = layerLoopLocal(CounterRows, RowsPorts).pipe(Layer.provide(Auto))
const RowsRpc = makeRpc(CounterRows, RowsPorts)
const RowsRemote = Layer.mergeAll(RowsRpc.layerModelRemote, RowsRpc.layerHistoryRemote, RowsRpc.layerIntentPortRemote).pipe(
  Layer.provide(RowsRpc.layerClientTest),
  Layer.provide(RowsRpc.layerHandlers),
  Layer.provide(RowsLocal)
)

const rowsHoldTheirIds = (r: RepresentationOf<typeof CounterRows>) =>
  assert.deepStrictEqual(r.parts.Rows.map((row) => row.key), r.parent.ids)

const rows = createTestModel(CounterRows, RowsPorts, {
  ...byModel,
  explore: exploreRows,
  states: {
    empty: (r) => {
      rowsHoldTheirIds(r)
      assert.deepStrictEqual(r.parent.ids, [])
    },
    listed: (r) => {
      rowsHoldTheirIds(r)
      assert.deepStrictEqual(r.parts.Rows.map((row) => row.representation.count < 3), r.parent.ids.map(() => true))
    },
    busy: (r) => {
      rowsHoldTheirIds(r)
      assert.strictEqual(r.parts.Rows.some((row) => row.representation.count >= 3), true)
    }
  }
})

const rowsIntentFor = (step: PathStep<typeof CounterRows>): IntentOf<typeof CounterRows> => {
  const proposal = step.proposal
  switch (proposal._tag) {
    case "Added":
      return { _tag: "Add", id: proposal.id }
    case "Removed":
      return { _tag: "Remove", id: proposal.id }
    case "Rows":
      return { _tag: "Rows", key: proposal.key, intent: counterIntentFor(proposal.proposal) }
  }
}

describe("a keyed collection of counters, local loop", () => {
  it.effect.each(named(rows, rows.shortestPaths()))("shortest: $name", ({ path }) =>
    rows.run(path).pipe(Effect.provide(RowsLocal)))
  it.effect.each(named(rows, rows.shortestPaths()))("through the actions: $name", ({ path }) =>
    rows.run(path, intentDriver(RowsPorts, rowsIntentFor)).pipe(Effect.provide(RowsLocal)))
})

describe("a keyed collection of counters, Rpc.layerClientTest", () => {
  it.effect.each(named(rows, rows.shortestPaths()))("shortest: $name", ({ path }) =>
    rows.run(path).pipe(Effect.provide(RowsRemote)))
  it.effect.each(named(rows, rows.shortestPaths()))("through the actions: $name", ({ path }) =>
    rows.run(path, intentDriver(RowsPorts, rowsIntentFor)).pipe(Effect.provide(RowsRemote)))
})
