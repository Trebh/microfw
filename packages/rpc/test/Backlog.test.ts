import { assert, describe, it } from "@effect/vitest"
import { AutoActions, HistoryBacklog, layerLoopLocal } from "@mufw/core"
import { Array as Arr, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { Counter, Ports } from "../../core/test/fixtures/Counter.ts"
import { settle } from "../../core/test/support.ts"
import { makeRpc, RepresentationBacklog } from "../src/index.ts"

const Rpc = makeRpc(Counter, Ports)

const inc1 = { _tag: "Inc", by: 1 } as const

/** The remote ports over in-process RPC, whose server holds `representations` representations and a history window of 2. */
const remote = (representations: number) =>
  Layer.merge(Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(
    Layer.provide(Rpc.layerClientTest),
    Layer.provide(Rpc.layerHandlers.pipe(Layer.provide(Layer.succeed(RepresentationBacklog, representations)))),
    Layer.provide(layerLoopLocal(Counter, Ports)),
    Layer.provide(Layer.succeed(HistoryBacklog, 2)),
    Layer.provide(Layer.succeed(AutoActions, false))
  )

/** 40 steps, each moving the counter up by one. */
const present40 = Effect.gen(function*() {
  const model = yield* Ports.ModelPort
  yield* Effect.forEach(Array.from({ length: 40 }), () => model.present(inc1), { discard: true })
})

describe("served streams for a client that stops reading", () => {
  it.effect("representations skip to the newest the server holds", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const gate = yield* Deferred.make<void>()
      const reader = yield* model.representations.pipe(
        Stream.tap(() => Deferred.await(gate)),
        Stream.takeUntil((representation) => representation.count === 40),
        Stream.map((representation) => representation.count),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* settle
      yield* present40

      yield* Deferred.succeed(gate, undefined)
      const counts = yield* Fiber.join(reader)

      assert.strictEqual(counts.at(-1), 40)
      assert.isBelow(counts.length, 41)
    }).pipe(Effect.provide(remote(1))))

  it.effect("representations arrive one by one while the burst fits in what the server holds", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const gate = yield* Deferred.make<void>()
      const reader = yield* model.representations.pipe(
        Stream.tap(() => Deferred.await(gate)),
        Stream.takeUntil((representation) => representation.count === 40),
        Stream.map((representation) => representation.count),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* settle
      yield* present40

      yield* Deferred.succeed(gate, undefined)
      const counts = yield* Fiber.join(reader)

      assert.deepStrictEqual(counts, Arr.range(0, 40))
    }).pipe(Effect.provide(remote(64))))

  it.effect("history reaches it complete and in order when it resumes", () =>
    Effect.gen(function*() {
      const history = yield* Ports.HistoryPort
      const gate = yield* Deferred.make<void>()
      const reader = yield* history.records.pipe(
        Stream.tap(() => Deferred.await(gate)),
        Stream.take(41),
        Stream.map((record) => record.seq),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* settle
      yield* present40

      yield* Deferred.succeed(gate, undefined)
      const seqs = yield* Fiber.join(reader)

      assert.deepStrictEqual(seqs, Arr.range(0, 40))
    }).pipe(Effect.provide(remote(64))))
})
