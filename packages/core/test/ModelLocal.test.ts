import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { AutoActions, HistoryLimit, layerLoopLocal, NoSuchStep } from "../src/index.ts"
import { Counter, Ports } from "./fixtures/Counter.ts"
import { collect, settle } from "./support.ts"

const Loop = layerLoopLocal(Counter, Ports)
const inc2 = { _tag: "Inc", by: 2 } as const
const inc1 = { _tag: "Inc", by: 1 } as const
const LimitedLoop = Loop.pipe(
  Layer.provide(Layer.succeed(HistoryLimit, 3)),
  Layer.provide(Layer.succeed(AutoActions, false))
)

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
      assert.deepStrictEqual(records.map((r) => r.travelledTo), [undefined, undefined, undefined, 1])
    }).pipe(Effect.provide(Loop)))

  it.effect("travelTo an unknown step fails with NoSuchStep", () =>
    Effect.gen(function*() {
      const history = yield* Ports.HistoryPort

      const exit = yield* Effect.exit(history.travelTo(99))

      assert.deepStrictEqual(exit, Exit.fail(new NoSuchStep({ seq: 99 })))
    }).pipe(Effect.provide(Loop)))

  it.effect("keeps the initial record and the newest ones at the limit, with their original seqs", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      yield* model.present(inc1)
      yield* model.present(inc1)
      yield* model.present(inc1)
      yield* model.present(inc1)

      const records = yield* history.records.pipe(Stream.take(3), Stream.runCollect)

      assert.deepStrictEqual(records.map((r) => [r.seq, r.model.count]), [
        [0, 0],
        [3, 3],
        [4, 4]
      ])
    }).pipe(Effect.provide(LimitedLoop)))

  it.effect("a subscriber sees the retained records, then live ones", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      yield* model.present(inc1)
      yield* model.present(inc1)
      yield* model.present(inc1)
      yield* model.present(inc1)
      const records = yield* collect(history.records)

      yield* model.present(inc1)
      yield* settle

      assert.deepStrictEqual(records.map((r) => r.seq), [0, 3, 4, 5])
    }).pipe(Effect.provide(LimitedLoop)))

  it.effect("travelTo an evicted step fails with NoSuchStep", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      yield* model.present(inc1)
      yield* model.present(inc1)
      yield* model.present(inc1)
      yield* model.present(inc1)

      const exit = yield* Effect.exit(history.travelTo(1))

      assert.deepStrictEqual(exit, Exit.fail(new NoSuchStep({ seq: 1 })))
    }).pipe(Effect.provide(LimitedLoop)))

  it.effect("travelTo the oldest retained step after the initial one still works", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      yield* model.present(inc1)
      yield* model.present(inc1)
      yield* model.present(inc1)
      yield* model.present(inc1)

      yield* history.travelTo(3)

      const current = yield* Stream.runHead(model.representations)
      assert.deepStrictEqual(Option.map(current, (r) => r.count), Option.some(3))
    }).pipe(Effect.provide(LimitedLoop)))

  it.effect("travelTo the initial step still works after it would have been evicted", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      yield* model.present(inc1)
      yield* model.present(inc1)
      yield* model.present(inc1)
      yield* model.present(inc1)

      const evicted = yield* Effect.exit(history.travelTo(1))
      yield* history.travelTo(0)

      const current = yield* Stream.runHead(model.representations)
      assert.deepStrictEqual(evicted, Exit.fail(new NoSuchStep({ seq: 1 })))
      assert.deepStrictEqual(Option.map(current, (r) => r.count), Option.some(0))
    }).pipe(Effect.provide(LimitedLoop)))
})

describe("layerModelLocal with an initial model", () => {
  const FromTwo = layerLoopLocal(Counter, Ports, { initial: { count: 2 } }).pipe(
    Layer.provide(Layer.succeed(AutoActions, false))
  )

  it.effect("emits the first representation and the seq 0 record from the given model", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort

      const first = yield* Stream.runHead(model.representations)
      const records = yield* history.records.pipe(Stream.take(1), Stream.runCollect)

      assert.deepStrictEqual(first, Option.some({ controlState: "low", count: 2 }))
      assert.deepStrictEqual(records.map((r) => [r.seq, r.kind, r.model.count]), [[0, "init", 2]])
    }).pipe(Effect.provide(FromTwo)))

  it.effect("steps from the given model and travelTo(0) returns to it", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      yield* model.present(inc1)
      const stepped = yield* Stream.runHead(model.representations)

      yield* history.travelTo(0)

      const restored = yield* Stream.runHead(model.representations)
      assert.deepStrictEqual(stepped, Option.some({ controlState: "high", count: 3 }))
      assert.deepStrictEqual(restored, Option.some({ controlState: "low", count: 2 }))
    }).pipe(Effect.provide(FromTwo)))
})
