import { assert, describe, it } from "@effect/vitest"
import { AutoActions, type IntentOf, layerLoopLocal, type Path, type PathStep } from "@mufw/core"
import { makeRpc } from "@mufw/rpc"
import { Effect, Layer } from "effect"
import { exploreNested, NestedCounter, NestedPorts } from "../../core/test/fixtures/NestedCounter.ts"
import { createTestModel, intentDriver } from "../src/index.ts"

const Rpc = makeRpc(NestedCounter, NestedPorts)

const Local = layerLoopLocal(NestedCounter, NestedPorts).pipe(Layer.provide(Layer.succeed(AutoActions, false)))

const Remote = Layer.mergeAll(Rpc.layerModelRemote, Rpc.layerHistoryRemote, Rpc.layerIntentPortRemote).pipe(
  Layer.provide(Rpc.layerClientTest),
  Layer.provide(Rpc.layerHandlers),
  Layer.provide(Local)
)

const model = createTestModel(NestedCounter, NestedPorts, {
  explore: exploreNested,
  states: {
    "low/low": (r) => assert.deepStrictEqual([r.parent.count < 3, r.child.count < 3], [true, true]),
    "low/high": (r) => assert.deepStrictEqual([r.parent.count < 3, r.child.count >= 3], [true, true]),
    "high/low": (r) => assert.deepStrictEqual([r.parent.count >= 3, r.child.count < 3], [true, true]),
    "high/high": (r) => assert.deepStrictEqual([r.parent.count >= 3, r.child.count >= 3], [true, true])
  }
})

const intentFor = (step: PathStep<typeof NestedCounter>): IntentOf<typeof NestedCounter> =>
  step.proposal._tag === "Child" ? { _tag: "Child", intent: step.proposal.proposal } : step.proposal

const named = (paths: ReadonlyArray<Path<typeof NestedCounter>>) =>
  paths.map((path) => ({ name: model.describe(path), path }))

describe("nested counter, local loop", () => {
  it.effect.each(named(model.shortestPaths()))("shortest: $name", ({ path }) =>
    model.run(path).pipe(Effect.provide(Local)))
  it.effect.each(named(model.simplePaths()))("simple: $name", ({ path }) =>
    model.run(path).pipe(Effect.provide(Local)))
  it.effect.each(named(model.shortestPaths()))("through the actions: $name", ({ path }) =>
    model.run(path, intentDriver(NestedPorts, intentFor)).pipe(Effect.provide(Local)))
})

describe("nested counter, Rpc.layerClientTest", () => {
  it.effect.each(named(model.shortestPaths()))("shortest: $name", ({ path }) =>
    model.run(path).pipe(Effect.provide(Remote)))
  it.effect.each(named(model.simplePaths()))("simple: $name", ({ path }) =>
    model.run(path).pipe(Effect.provide(Remote)))
  it.effect.each(named(model.shortestPaths()))("through the actions: $name", ({ path }) =>
    model.run(path, intentDriver(NestedPorts, intentFor)).pipe(Effect.provide(Remote)))
})
