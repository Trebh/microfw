import { assert, describe, it } from "@effect/vitest"
import { ActionFailure, layerLoopLocal, NoSuchStep } from "@mufw/core"
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import { Counter, Ports } from "../../core/test/fixtures/Counter.ts"
import { makeRpc } from "../src/index.ts"

const Rpc = makeRpc(Counter, Ports)

const Remote = Layer.mergeAll(Rpc.layerModelRemote, Rpc.layerHistoryRemote, Rpc.layerActionRunnerRemote).pipe(
  Layer.provide(Rpc.layerClientTest),
  Layer.provide(Rpc.layerHandlers),
  Layer.provide(layerLoopLocal(Counter, Ports))
)

describe("remote ports over in-process RPC", () => {
  it.effect("present reaches the server model and representations stream back", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const subscribed = yield* Deferred.make<void>()
      const observed = yield* model.representations.pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Deferred.await(subscribed)

      yield* model.present({ _tag: "Inc", by: 1 })

      const counts = (yield* Fiber.join(observed)).map((r) => r.count)
      assert.deepStrictEqual(counts, [0, 1])
    }).pipe(Effect.provide(Remote)))

  it.effect("travelTo resets the server model", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      yield* model.present({ _tag: "Inc", by: 1 })

      yield* history.travelTo(0)

      const current = yield* Stream.runHead(model.representations)
      assert.deepStrictEqual(Option.map(current, (r) => r.count), Option.some(0))
    }).pipe(Effect.provide(Remote)))

  it.effect("travelTo an unknown step fails with NoSuchStep across the wire", () =>
    Effect.gen(function*() {
      const history = yield* Ports.HistoryPort

      const error = yield* Effect.flip(history.travelTo(99))

      assert.instanceOf(error, NoSuchStep)
      assert.strictEqual(error.seq, 99)
    }).pipe(Effect.provide(Remote)))

  it.effect("run returns the proposal computed by the server action", () =>
    Effect.gen(function*() {
      const runner = yield* Ports.ActionRunner

      const proposal = yield* runner.run({ _tag: "Inc", by: 5 })

      assert.deepStrictEqual(proposal, { _tag: "Inc", by: 5 })
    }).pipe(Effect.provide(Remote)))

  it.effect("run fails with the server action's ActionFailure", () =>
    Effect.gen(function*() {
      const runner = yield* Ports.ActionRunner

      const error = yield* Effect.flip(runner.run({ _tag: "Fail" }))

      assert.instanceOf(error, ActionFailure)
      assert.deepStrictEqual([error.intentTag, error.message], ["Fail", "boom"])
    }).pipe(Effect.provide(Remote)))
})
