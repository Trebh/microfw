import { assert, describe, it } from "@effect/vitest"
import { AutoActions, type Explore, layerLoopLocal } from "@mufw/core"
import { Effect, Layer, Stream } from "effect"
import { Counter, Ports } from "../../core/test/fixtures/Counter.ts"
import { createTestModel, intentDriver, PathFailure } from "../src/index.ts"

const explore: Explore<typeof Counter> = () => [{ _tag: "Inc", by: 1 }, { _tag: "Inc", by: 3 }, { _tag: "Reset" }]

const Loop = layerLoopLocal(Counter, Ports).pipe(Layer.provide(Layer.succeed(AutoActions, false)))

const model = createTestModel(Counter, Ports, {
  explore,
  states: {
    low: (representation) => assert.isBelow(representation.count, 3),
    high: (representation) => assert.isAtLeast(representation.count, 3)
  }
})

const pathTo = (target: string) => model.shortestPaths().find((path) => path.target === target)!

describe("createTestModel", () => {
  it.effect.each(model.shortestPaths().map((path) => ({ name: model.describe(path), path })))(
    "$name",
    ({ path }) => model.run(path).pipe(Effect.provide(Loop))
  )

  it.effect("fails with the step and message of a failing state assertion", () =>
    Effect.gen(function*() {
      const failing = createTestModel(Counter, Ports, {
        explore,
        states: { low: () => {}, high: () => assert.fail("nope") }
      })

      const failure = yield* Effect.flip(failing.run(pathTo("high")))

      assert.instanceOf(failure, PathFailure)
      assert.deepStrictEqual([failure.target, failure.stepIndex, failure.message], ["high", 0, "nope"])
    }).pipe(Effect.provide(Loop)))

  it.effect("fails with expected and actual nodes when the system drifts from the model", () => {
    const Ignoring = Layer.mergeAll(
      Layer.succeed(Ports.ModelPort, {
        present: () => Effect.void,
        representations: Stream.make({ controlState: "low" as const, count: 0 })
      }),
      Layer.succeed(Ports.HistoryPort, { records: Stream.empty, travelTo: () => Effect.void })
    )
    return Effect.gen(function*() {
      const failure = yield* Effect.flip(model.run(pathTo("high")))

      assert.deepStrictEqual([failure.expected, failure.actual, failure.stepIndex], ["high", "low", 0])
    }).pipe(Effect.provide(Ignoring))
  })

  it.effect("intentDriver reaches the target through the actions", () =>
    model.run(pathTo("high"), intentDriver(Ports, (step) => step.proposal)).pipe(Effect.provide(Loop)))

  it("throws at construction when a declared control state is unreachable", () => {
    const declared = { ...Counter, controlStates: ["low", "high", "frozen"] }

    assert.throws(
      () => createTestModel(declared, Ports, { explore, states: { low: () => {}, high: () => {} } }),
      "mufw: unreachable control states: frozen"
    )
  })
})
