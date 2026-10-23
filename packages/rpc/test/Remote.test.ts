import { assert, describe, it } from "@effect/vitest"
import { ActionFailure, layerLoopLocal, NoSuchStep, replayInto } from "@mufw/core"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { RpcClient, RpcServer } from "effect/rpc"
import { TestClock } from "effect/testing"
import { Counter, Ports } from "../../core/test/fixtures/Counter.ts"
import { initRecord, stepRecord } from "../../core/test/fixtures/CounterHistory.ts"
import { settle } from "../../core/test/support.ts"
import { makeRpc, type SamClient } from "../src/index.ts"

const Rpc = makeRpc(Counter, Ports)

const Loop = layerLoopLocal(Counter, Ports)

const Remote = Layer.mergeAll(
  Rpc.layerIntentPortRemote,
  Rpc.layerModelRemote,
  Rpc.layerHistoryRemote,
  Rpc.layerActionRunnerRemote
).pipe(
  Layer.provide(Rpc.layerClientTest),
  Layer.provide(Rpc.layerHandlers),
  Layer.provide(Loop)
)

interface ResponseSink {
  write(response: unknown): Effect.Effect<void>
}

/** A client of the whole contract talking, in-process, to a server that serves only `served`. */
const clientOfPartialServer = (served: Parameters<typeof Rpc.exposing>[0]) =>
  Effect.gen(function*() {
    let client: ResponseSink | undefined
    const server = yield* RpcServer.makeNoSerialization(Rpc.exposing(served), {
      onFromServer: (response) => client!.write(response)
    })
    const made = yield* RpcClient.makeNoSerialization(Rpc.group, {
      supportsAck: true,
      onFromClient: ({ message }) => server.write(0, message)
    })
    client = made as unknown as ResponseSink
    return made.client as unknown as SamClient<typeof Counter>
  })

const ServerSide = Rpc.layerHandlers.pipe(Layer.provideMerge(Loop))

describe("served RPCs", () => {
  it.effect("a server without Present does not apply a client's proposal", () =>
    Effect.gen(function*() {
      const client = yield* clientOfPartialServer(["Submit", "Representations"])

      const presented = yield* Effect.exit(client.Present({ _tag: "Inc", by: 100 }))
      const current = yield* client.Representations().pipe(Stream.runHead)

      assert.isTrue(Exit.isFailure(presented))
      assert.deepStrictEqual(Option.map(current, (r) => r.count), Option.some(0))
    }).pipe(Effect.provide(ServerSide)))

  it.effect("the served RPCs still work", () =>
    Effect.gen(function*() {
      const client = yield* clientOfPartialServer(["Submit", "Representations"])

      yield* client.Submit({ _tag: "Inc", by: 2 })
      const reached = yield* client.Representations().pipe(Stream.filter((r) => r.count === 2), Stream.runHead)

      assert.isTrue(Option.isSome(reached))
    }).pipe(Effect.provide(ServerSide)))
})

describe("remote ports over in-process RPC", () => {
  it.effect("an intent submitted through the remote IntentPort runs the server's action", () =>
    Effect.gen(function*() {
      const intents = yield* Ports.IntentPort
      const model = yield* Ports.ModelPort

      yield* intents.dispatch({ _tag: "Inc", by: 2 })
      const reached = yield* model.representations.pipe(Stream.filter((r) => r.count === 2), Stream.runHead)

      assert.isTrue(Option.isSome(reached))
    }).pipe(Effect.provide(Remote)))
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

  it.effect("replayInto applies a recorded automatic proposal once on a server that runs automatic actions", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const recorded = [
        initRecord(0),
        stepRecord(1, { _tag: "Inc", by: 4 }, 4),
        stepRecord(2, { _tag: "Reset" }, 0),
        stepRecord(3, { _tag: "Inc", by: 1 }, 1)
      ]

      yield* replayInto(Ports, recorded, 0)
      yield* settle
      yield* TestClock.adjust("2 seconds")

      const current = yield* Stream.runHead(model.representations)
      assert.deepStrictEqual(Option.map(current, (r) => r.count), Option.some(1))
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
