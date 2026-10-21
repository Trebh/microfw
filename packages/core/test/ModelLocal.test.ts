import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import { layerLoopLocal, NoSuchStep } from "../src/index.ts"
import { Counter, Ports } from "./fixtures/Counter.ts"
import { collect, settle } from "./support.ts"

const Loop = layerLoopLocal(Counter, Ports)
const inc2 = { _tag: "Inc", by: 2 } as const

describe("layerModelLocal", () => {
  it.effect("publishes the current representation, then one per step", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const subscribed = yield* Deferred.make<void>()
      const observed = yield* model.representations.pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Deferred.await(subscribed)

      yield* model.present(inc2)
      yield* model.present(inc2)

      const representations = yield* Fiber.join(observed)
      assert.deepStrictEqual(representations.map((r) => [r.controlState, r.count]), [
        ["low", 0],
        ["low", 2],
        ["high", 4]
      ])
    }).pipe(Effect.provide(Loop)))

  it.effect("records every step with its proposal", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort

      yield* model.present(inc2)
      yield* model.present(inc2)

      const records = yield* history.records.pipe(Stream.take(3), Stream.runCollect)
      assert.deepStrictEqual(records.map((r) => [r.seq, r.kind, r.proposal, r.model.count]), [
        [0, "init", Option.none(), 0],
        [1, "step", Option.some(inc2), 2],
        [2, "step", Option.some(inc2), 4]
      ])
    }).pipe(Effect.provide(Loop)))

  it.effect("travelTo restores a recorded model and appends a travel record", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      yield* model.present(inc2)
      yield* model.present(inc2)
      const records = yield* collect(history.records)

      yield* history.travelTo(1)
      yield* settle

      const current = yield* Stream.runHead(model.representations)
      assert.deepStrictEqual(Option.map(current, (r) => r.count), Option.some(2))
      assert.deepStrictEqual(records.map((r) => [r.seq, r.kind, r.model.count]), [
        [0, "init", 0],
        [1, "step", 2],
        [2, "step", 4],
        [3, "travel", 2]
      ])
    }).pipe(Effect.provide(Loop)))

  it.effect("travelTo an unknown step fails with NoSuchStep", () =>
    Effect.gen(function*() {
      const history = yield* Ports.HistoryPort

      const exit = yield* Effect.exit(history.travelTo(99))

      assert.deepStrictEqual(exit, Exit.fail(new NoSuchStep({ seq: 99 })))
    }).pipe(Effect.provide(Loop)))
})
