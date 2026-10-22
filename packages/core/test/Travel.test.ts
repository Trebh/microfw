import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { layerActionsDrain, layerIntentBus, layerLoopLocal, layerModelLocal } from "../src/index.ts"
import { Counter, Ports } from "./fixtures/Counter.ts"
import { collect, settle } from "./support.ts"

const Loop = layerLoopLocal(Counter, Ports)

/** A loop whose actions are an opaque port, as when they run on a server: each one waits for `gate`. */
const gatedLoop = (gate: Deferred.Deferred<void>, interrupted: Array<string>) => {
  const runner = Layer.succeed(Ports.ActionRunner, {
    run: (intent) =>
      Deferred.await(gate).pipe(
        Effect.as({ _tag: "Reset" } as const),
        Effect.onInterrupt(() => Effect.sync(() => interrupted.push(intent._tag)))
      )
  })
  return layerActionsDrain(Counter, Ports).pipe(
    Layer.provideMerge(Layer.merge(layerModelLocal(Counter, Ports), runner)),
    Layer.provideMerge(layerIntentBus(Counter, Ports))
  )
}

const inc = (by: number) => ({ _tag: "Inc", by }) as const

describe("travelTo and actions in flight", () => {
  it.effect("an automatic action running during travelTo does not change the model afterwards", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      const records = yield* collect(history.records)
      yield* model.present(inc(1))
      yield* model.present(inc(2))
      yield* settle

      yield* history.travelTo(1)
      yield* TestClock.adjust("5 seconds")

      const current = yield* Stream.runHead(model.representations)
      assert.deepStrictEqual(Option.map(current, (r) => r.count), Option.some(1))
      assert.deepStrictEqual(records.map((r) => r.kind), ["init", "step", "step", "travel"])
    }).pipe(Effect.provide(Loop)))

  it.effect("an automatic round starts again with the first step after a travel", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      yield* model.present(inc(1))
      yield* model.present(inc(2))
      yield* settle
      yield* history.travelTo(1)

      yield* model.present(inc(2))
      yield* settle
      yield* TestClock.adjust("1 second")

      const current = yield* Stream.runHead(model.representations)
      assert.deepStrictEqual(Option.map(current, (r) => r.count), Option.some(0))
    }).pipe(Effect.provide(Loop)))

  it.effect("a failed travelTo leaves the automatic action in flight", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      yield* model.present(inc(3))
      yield* settle

      yield* Effect.ignore(history.travelTo(99))
      yield* TestClock.adjust("1 second")

      const current = yield* Stream.runHead(model.representations)
      assert.deepStrictEqual(Option.map(current, (r) => r.count), Option.some(0))
    }).pipe(Effect.provide(Loop)))

  it.effect("interrupts an automatic action behind the ActionRunner port, so it presents nothing", () => {
    const gate = Deferred.makeUnsafe<void>()
    const interrupted: Array<string> = []
    return Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      const records = yield* collect(history.records)
      yield* model.present(inc(1))
      yield* model.present(inc(2))
      yield* settle

      yield* history.travelTo(1)
      yield* Deferred.succeed(gate, undefined)
      yield* settle

      assert.deepStrictEqual(interrupted, ["AutoReset"])
      assert.deepStrictEqual(records.map((r) => r.kind), ["init", "step", "step", "travel"])
    }).pipe(Effect.provide(gatedLoop(gate, interrupted)))
  })

  it.effect("a user action running during travelTo still presents its proposal", () => {
    const gate = Deferred.makeUnsafe<void>()
    return Effect.gen(function*() {
      const bus = yield* Ports.IntentBus
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      const records = yield* collect(history.records)
      yield* model.present(inc(1))
      yield* bus.dispatch({ _tag: "Reset" })
      yield* settle

      yield* history.travelTo(0)
      yield* Deferred.succeed(gate, undefined)
      yield* settle

      assert.deepStrictEqual(records.map((r) => r.kind), ["init", "step", "travel", "step"])
    }).pipe(Effect.provide(gatedLoop(gate, [])))
  })
})
