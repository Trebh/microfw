import { assert, describe, it } from "@effect/vitest"
import { AutoActions, layerLoopLocal, unreachableControlStates } from "@mufw/core"
import { intentDriver } from "@mufw/test"
import { Effect, Layer, Option, Stream } from "effect"
import { layerCurrentPatronFixed } from "../src/adapters/currentPatronFixed.ts"
import { layerPaymentTheatrical } from "../src/adapters/paymentTheatrical.ts"
import { BoxOffice, BoxOfficePorts, type Intent, Patron } from "../src/domain/BoxOffice.ts"
import { boxOfficeModel as model } from "./BoxOffice.pathModel.ts"

const named = (paths: typeof model.shortestPaths) => paths().map((path) => ({ name: model.describe(path), path }))

const Local = layerLoopLocal(BoxOffice, BoxOfficePorts).pipe(
  Layer.provide(layerPaymentTheatrical),
  Layer.provide(layerCurrentPatronFixed(Patron.make("guest"))),
  Layer.provide(Layer.succeed(AutoActions, false))
)

describe("the explored graph", () => {
  it("reaches every control state", () => {
    assert.deepStrictEqual(unreachableControlStates(BoxOffice, model.graph), [])
  })

  it("stays small enough to rehearse", () => {
    assert.isBelow(model.graph.states.size, 40)
  })
})

describe("local placement", () => {
  it.effect.each(named(model.shortestPaths))("shortest: $name", ({ path }) => model.run(path).pipe(Effect.provide(Local)))
  it.effect.each(named(model.simplePaths))("simple: $name", ({ path }) => model.run(path).pipe(Effect.provide(Local)))
})

describe("intent driver", () => {
  const intentFor = (tag: string): Intent => (tag === "DoorsOpened" ? { _tag: "OpenDoors" } : { _tag: "RaiseCurtain" })

  it.effect("reaches the curtain through the real actions", () =>
    Effect.gen(function*() {
      const toCurtain = model.shortestPaths().find((path) => path.target === "curtain")!

      yield* model.run(toCurtain, intentDriver(BoxOfficePorts, (step) => intentFor(step.proposal._tag)))

      const latest = yield* BoxOfficePorts.ModelPort.use((port) => Stream.runHead(port.representations)).pipe(
        Effect.map(Option.getOrThrow)
      )
      assert.strictEqual(latest.controlState, "curtain")
    }).pipe(Effect.provide(Local)))
})
