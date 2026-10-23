import { assert, describe, it } from "@effect/vitest"
import { layerLoopLocal } from "@mufw/core"
import { Effect, Exit, Fiber, Layer, Option, Ref, Stream } from "effect"
import { HttpClientError } from "effect/http"
import { RpcClientError } from "effect/rpc"
import { Socket } from "effect/socket"
import { TestClock } from "effect/testing"
import { Counter, Ports } from "../../core/test/fixtures/Counter.ts"
import { settle } from "../../core/test/support.ts"
import { makeRpc, type SamClient } from "../src/index.ts"

const Rpc = makeRpc(Counter, Ports)

const socketLost = () =>
  new RpcClientError.RpcClientError({ reason: new Socket.SocketReadError({ cause: "connection reset" }) })

const malformedFrame = () =>
  new RpcClientError.RpcClientError({ reason: new RpcClientError.RpcClientDefect({ message: "bad frame", cause: "x" }) })

const httpLost = (kind: "TransportError" | "DecodeError" | "StatusCodeError") => () =>
  new RpcClientError.RpcClientError({
    reason: new HttpClientError.HttpClientErrorSchema({ _tag: "HttpError", kind, cause: "connection reset" })
  })

/** The real client, except that its first `Representations` and `History` streams fail with `failure`. */
const failingFirst = (failure: () => RpcClientError.RpcClientError, keepFirst: number) =>
  Layer.effect(
    Rpc.Client,
    Effect.gen(function*() {
      const real = yield* Rpc.Client
      const attempts = yield* Ref.make(0)
      const firstAttemptFails = <A>(stream: Stream.Stream<A, RpcClientError.RpcClientError>) =>
        Stream.unwrap(
          Ref.getAndUpdate(attempts, (n) => n + 1).pipe(
            Effect.map((n) =>
              n === 0 ? stream.pipe(Stream.take(keepFirst), Stream.concat(Stream.fail(failure()))) : stream
            )
          )
        )
      const client: SamClient<typeof Counter> = {
        ...real,
        Representations: () => firstAttemptFails(real.Representations()),
        History: () => firstAttemptFails(real.History())
      }
      return client
    })
  ).pipe(Layer.provide(Rpc.layerClientTest))

const remoteOver = (failure: () => RpcClientError.RpcClientError, keepFirst: number) =>
  Layer.merge(Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(
    Layer.provide(failingFirst(failure, keepFirst)),
    Layer.provide(Rpc.layerHandlers),
    Layer.provide(layerLoopLocal(Counter, Ports))
  )

describe("remote streams after a lost socket", () => {
  it.effect("representations resume once the socket is back", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      yield* model.present({ _tag: "Inc", by: 1 })

      const resumed = yield* model.representations.pipe(Stream.runHead, Effect.forkChild)
      yield* TestClock.adjust("1 second")

      const current = yield* Fiber.join(resumed)
      assert.deepStrictEqual(Option.map(current, (r) => r.count), Option.some(1))
    }).pipe(Effect.provide(remoteOver(socketLost, 0))))

  it.effect("representations resume after an HTTP request that could not reach the server", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      yield* model.present({ _tag: "Inc", by: 1 })

      const resumed = yield* model.representations.pipe(Stream.runHead, Effect.forkChild)
      yield* TestClock.adjust("1 second")

      const current = yield* Fiber.join(resumed)
      assert.deepStrictEqual(Option.map(current, (r) => r.count), Option.some(1))
    }).pipe(Effect.provide(remoteOver(httpLost("TransportError"), 0))))

  it.effect("representations resume after an HTTP response body was cut", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      yield* model.present({ _tag: "Inc", by: 1 })

      const resumed = yield* model.representations.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
      yield* settle
      yield* TestClock.adjust("1 second")

      const delivered = yield* Fiber.join(resumed)
      assert.deepStrictEqual(delivered.map((r) => r.count), [1, 1])
    }).pipe(Effect.provide(remoteOver(httpLost("DecodeError"), 1))))

  it.effect("an HTTP status error is still a defect", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort

      const exit = yield* Stream.runHead(model.representations).pipe(Effect.exit)

      assert.isTrue(Exit.hasDies(exit))
    }).pipe(Effect.provide(remoteOver(httpLost("StatusCodeError"), 0))))

  it.effect("a malformed frame is still a defect", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort

      const exit = yield* Stream.runHead(model.representations).pipe(Effect.exit)

      assert.isTrue(Exit.hasDies(exit))
    }).pipe(Effect.provide(remoteOver(malformedFrame, 0))))

  it.effect("history delivers each record once across a resubscription", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      yield* model.present({ _tag: "Inc", by: 1 })
      yield* model.present({ _tag: "Inc", by: 2 })

      const records = yield* history.records.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild)
      yield* TestClock.adjust("1 second")

      const delivered = yield* Fiber.join(records)
      assert.deepStrictEqual(delivered.map((r) => r.seq), [0, 1, 2])
    }).pipe(Effect.provide(remoteOver(socketLost, 2))))
})
