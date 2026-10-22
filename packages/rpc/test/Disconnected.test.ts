import { assert, describe, it } from "@effect/vitest"
import { layerLoopLocal } from "@mufw/core"
import { Effect, Exit, Fiber, Latch, Layer, Option, Queue, Ref, Schedule, Scope, Stream } from "effect"
import { NetAddress } from "effect/net"
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc"
import { Socket, SocketServer } from "effect/socket"
import { TestClock } from "effect/testing"
import { Counter, Ports } from "../../core/test/fixtures/Counter.ts"
import { layerHoldRequestsWhileDisconnected, makeRpc } from "../src/index.ts"

const Rpc = makeRpc(Counter, Ports)

type Frame = Uint8Array | string

type Inbox = Queue.Queue<Frame, Socket.SocketError>

interface Link {
  readonly toClient: Inbox
  readonly toServer: Inbox
}

const connectionReset = () =>
  new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: "connection reset" }) })
const peerGone = () => new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1006 }) })
const openRefused = () =>
  new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause: "refused" }) })

const writerInto = (inbox: Inbox): Socket.Writer => ({
  write: (chunk) => (Socket.isCloseEvent(chunk) ? Effect.void : Effect.asVoid(Queue.offer(inbox, chunk))),
  writeAll: (chunks) => Effect.asVoid(Queue.offerAll(inbox, chunks))
})

/**
 * A client socket wired in memory to the real RPC socket server. A dial while `stop` has been
 * called is refused; `stop` also cuts the live connection. `requests` collects the tag of every
 * `Request` frame the client writes, `dialled` signals each successful dial, `disconnected` each
 * time the client protocol notices a lost connection.
 */
const makeNetwork = Effect.gen(function*() {
  const incoming = yield* Queue.make<Socket.Socket>()
  const dialled = yield* Queue.make<void>()
  const disconnected = yield* Queue.make<void>()
  const requests = yield* Queue.make<string>()
  const reachable = yield* Ref.make(true)
  const current = yield* Ref.make<Link | undefined>(undefined)
  const connected = Latch.makeUnsafe(false)

  const recordRequest = (chunk: Frame) => {
    const message = JSON.parse(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return message._tag === "Request" ? Queue.offer(requests, message.tag as string) : Effect.void
  }

  const write = (chunk: Socket.CloseEvent | Frame): Effect.Effect<void, Socket.SocketError> =>
    Effect.suspend(() =>
      Ref.get(current).pipe(
        Effect.flatMap((link) => {
          if (link === undefined) return connected.whenOpen(write(chunk))
          if (Socket.isCloseEvent(chunk)) return Effect.void
          return recordRequest(chunk).pipe(Effect.andThen(Queue.offer(link.toServer, chunk)), Effect.asVoid)
        })
      )
    )

  const reader = Effect.gen(function*() {
    if (!(yield* Ref.get(reachable))) return yield* Effect.fail(openRefused())
    const scope = yield* Effect.scope
    const toClient: Inbox = yield* Queue.make<Frame, Socket.SocketError>()
    const toServer: Inbox = yield* Queue.make<Frame, Socket.SocketError>()
    const serverSocket = Socket.make({
      reader: Effect.succeed({ pull: Queue.takeAll(toServer), upgrade: () => Effect.void }),
      writer: Effect.succeed(writerInto(toClient))
    })
    yield* Queue.offer(incoming, serverSocket)
    yield* Ref.set(current, { toClient, toServer })
    connected.openUnsafe()
    yield* Scope.addFinalizer(
      scope,
      Ref.set(current, undefined).pipe(
        Effect.andThen(Effect.sync(() => connected.closeUnsafe())),
        Effect.andThen(Queue.fail(toServer, peerGone()))
      )
    )
    yield* Queue.offer(dialled, undefined)
    return { pull: Queue.takeAll(toClient), upgrade: () => Effect.void }
  })

  const socket = Socket.make({
    reader,
    writer: Effect.succeed({
      write,
      writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true })
    })
  })

  const server = SocketServer.SocketServer.of({
    address: NetAddress.unixPathAddress("memory"),
    run: (handler) =>
      Queue.take(incoming).pipe(
        Effect.flatMap((accepted) => Effect.forkChild(handler(accepted))),
        Effect.forever
      )
  })

  const cutConnection = Ref.get(current).pipe(
    Effect.flatMap((link) => (link === undefined ? Effect.void : Queue.fail(link.toClient, connectionReset())))
  )
  const stop = Ref.set(reachable, false).pipe(Effect.andThen(cutConnection))
  const start = Ref.set(reachable, true)

  const hooks = Layer.succeed(RpcClient.ConnectionHooks, {
    onConnect: Effect.void,
    onDisconnect: Effect.asVoid(Queue.offer(disconnected, undefined))
  })

  return { socket, server, hooks, requests, dialled, disconnected, stop, start }
})

type Network = Effect.Success<typeof makeNetwork>

const Loop = layerLoopLocal(Counter, Ports)

const serverOver = (network: Network) =>
  RpcServer.layer(Rpc.group).pipe(
    Layer.provide(Rpc.layerHandlers.pipe(Layer.provide(Loop))),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(Layer.merge(Layer.succeed(SocketServer.SocketServer, network.server), RpcSerialization.layerJson))
  )

const protocolOver = (network: Network) =>
  layerHoldRequestsWhileDisconnected.pipe(
    Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true, retryPolicy: Schedule.spaced("1 second") })),
    Layer.provide(
      Layer.mergeAll(Layer.succeed(Socket.Socket, network.socket), RpcSerialization.layerJson, network.hooks)
    )
  )

const clientAbove = Layer.mergeAll(Rpc.layerModelRemote, Rpc.layerActionRunnerRemote).pipe(
  Layer.provide(Rpc.layerClient)
)

const clientOver = (network: Network) => clientAbove.pipe(Layer.provide(protocolOver(network)))

const overNetwork = <A, E, R>(network: Network, body: Effect.Effect<A, E, R>) =>
  body.pipe(Effect.provide(Layer.merge(clientOver(network), serverOver(network))))

describe("calls made while the socket is down", () => {
  it.effect("a proposal presented while disconnected reaches the server once, after the reconnection", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const count = yield* overNetwork(
        network,
        Effect.gen(function*() {
          const model = yield* Ports.ModelPort
          yield* Queue.take(network.dialled)
          yield* network.stop
          yield* Queue.take(network.disconnected)

          const presented = yield* Effect.forkChild(model.present({ _tag: "Inc", by: 1 }))
          yield* TestClock.adjust("500 millis")
          yield* network.start
          yield* TestClock.adjust("1 second")
          yield* Queue.take(network.dialled)
          yield* TestClock.adjust("250 millis")
          yield* Fiber.join(presented)

          const current = yield* Stream.runHead(model.representations)
          return Option.map(current, (representation) => representation.count)
        })
      )

      assert.deepStrictEqual(count, Option.some(1))
    }))

  it.effect("a dispatch issued while disconnected completes after the reconnection", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const proposal = yield* overNetwork(
        network,
        Effect.gen(function*() {
          const runner = yield* Ports.ActionRunner
          yield* Queue.take(network.dialled)
          yield* network.stop
          yield* Queue.take(network.disconnected)

          const dispatched = yield* Effect.forkChild(runner.run({ _tag: "Inc", by: 2 }))
          yield* TestClock.adjust("500 millis")
          yield* network.start
          yield* TestClock.adjust("1 second")
          yield* Queue.take(network.dialled)
          yield* TestClock.adjust("250 millis")
          return yield* Fiber.join(dispatched)
        })
      )

      assert.deepStrictEqual(proposal, { _tag: "Inc", by: 2 })
    }))

  it.effect("calls issued in order while disconnected are applied in that order after the reconnection", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const count = yield* overNetwork(
        network,
        Effect.gen(function*() {
          const model = yield* Ports.ModelPort
          yield* Queue.take(network.dialled)
          yield* network.stop
          yield* Queue.take(network.disconnected)

          yield* TestClock.adjust("100 millis")
          const increased = yield* Effect.forkChild(model.present({ _tag: "Inc", by: 2 }))
          yield* TestClock.adjust("200 millis")
          const reset = yield* Effect.forkChild(model.present({ _tag: "Reset" }))
          yield* TestClock.adjust("200 millis")
          yield* network.start
          yield* TestClock.adjust("1 second")
          yield* Queue.take(network.dialled)
          yield* TestClock.adjust("500 millis")
          yield* Fiber.join(increased)
          yield* Fiber.join(reset)

          const current = yield* Stream.runHead(model.representations)
          return Option.map(current, (representation) => representation.count)
        })
      )

      assert.deepStrictEqual(count, Option.some(0))
    }))

  it.effect("a call issued as the first held call is written is applied after the held calls issued before it", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const count = yield* overNetwork(
        network,
        Effect.gen(function*() {
          const model = yield* Ports.ModelPort
          yield* Queue.take(network.dialled)
          yield* network.stop
          yield* Queue.take(network.disconnected)

          const first = yield* Effect.forkChild(model.present({ _tag: "Inc", by: 1 }))
          yield* TestClock.adjust("100 millis")
          const second = yield* Effect.forkChild(model.present({ _tag: "Reset" }))
          yield* TestClock.adjust("100 millis")
          const third = yield* Effect.forkChild(
            Queue.take(network.requests).pipe(Effect.andThen(model.present({ _tag: "Inc", by: 1 })))
          )
          yield* network.start
          yield* TestClock.adjust("1 second")
          yield* Queue.take(network.dialled)
          yield* TestClock.adjust("500 millis")
          yield* Fiber.join(first)
          yield* Fiber.join(second)
          yield* Fiber.join(third)

          const current = yield* Stream.runHead(model.representations)
          return Option.map(current, (representation) => representation.count)
        })
      )

      assert.deepStrictEqual(count, Option.some(1))
    }))
})

describe("calls abandoned while the socket is down", () => {
  it.effect("a call interrupted behind the first held call is never written", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const { written, count } = yield* overNetwork(
        network,
        Effect.gen(function*() {
          const model = yield* Ports.ModelPort
          yield* Queue.take(network.dialled)
          yield* network.stop
          yield* Queue.take(network.disconnected)

          const first = yield* Effect.forkChild(model.present({ _tag: "Inc", by: 1 }))
          yield* TestClock.adjust("100 millis")
          const abandoned = yield* Effect.forkChild(model.present({ _tag: "Inc", by: 5 }))
          yield* TestClock.adjust("100 millis")
          yield* Fiber.interrupt(abandoned)
          yield* network.start
          yield* TestClock.adjust("1 second")
          yield* Queue.take(network.dialled)
          yield* TestClock.adjust("500 millis")
          yield* Fiber.join(first)

          const written = yield* Queue.clear(network.requests)
          const current = yield* Stream.runHead(model.representations)
          return { written, count: Option.map(current, (representation) => representation.count) }
        })
      )

      assert.deepStrictEqual(written, ["Present"])
      assert.deepStrictEqual(count, Option.some(1))
    }))

  it.effect("the first held call interrupted before the reconnection is never written, the next one is", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const { written, count } = yield* overNetwork(
        network,
        Effect.gen(function*() {
          const model = yield* Ports.ModelPort
          yield* Queue.take(network.dialled)
          yield* network.stop
          yield* Queue.take(network.disconnected)

          const abandoned = yield* Effect.forkChild(model.present({ _tag: "Inc", by: 5 }))
          yield* TestClock.adjust("100 millis")
          const next = yield* Effect.forkChild(model.present({ _tag: "Inc", by: 1 }))
          yield* TestClock.adjust("100 millis")
          yield* Fiber.interrupt(abandoned)
          yield* network.start
          yield* TestClock.adjust("1 second")
          yield* Queue.take(network.dialled)
          yield* TestClock.adjust("500 millis")
          yield* Fiber.join(next)

          const written = yield* Queue.clear(network.requests)
          const current = yield* Stream.runHead(model.representations)
          return { written, count: Option.map(current, (representation) => representation.count) }
        })
      )

      assert.deepStrictEqual(written, ["Present"])
      assert.deepStrictEqual(count, Option.some(1))
    }))

  it.effect("a held call still queued when the protocol's scope closes is interrupted instead of left waiting", () =>
    Effect.scoped(Effect.gen(function*() {
      const network = yield* makeNetwork
      const protocolScope = yield* Scope.make()
      const protocol = yield* Layer.buildWithScope(protocolOver(network), protocolScope)
      const client = clientAbove.pipe(Layer.provide(Layer.succeedContext(protocol)))
      const context = yield* Layer.build(Layer.merge(client, serverOver(network)))

      const exit = yield* Effect.gen(function*() {
        const model = yield* Ports.ModelPort
        yield* Queue.take(network.dialled)
        yield* network.stop
        yield* Queue.take(network.disconnected)

        const held = yield* Effect.forkChild(model.present({ _tag: "Inc", by: 1 }))
        yield* TestClock.adjust("100 millis")
        yield* Scope.close(protocolScope, Exit.void)
        return yield* Fiber.await(held)
      }).pipe(Effect.provideContext(context))

      assert.isTrue(Exit.hasInterrupts(exit))
    })))
})

/** A `Dispatch` the server is still running (its action sleeps) when the connection is cut, then a reconnection. */
const dropWhileRunning = (network: Network) =>
  overNetwork(
    network,
    Effect.gen(function*() {
      const runner = yield* Ports.ActionRunner
      yield* Queue.take(network.dialled)
      const running = yield* Effect.forkChild(runner.run({ _tag: "AutoReset" }))
      yield* Queue.take(network.requests)
      yield* network.stop
      yield* Queue.take(network.disconnected)
      const exit = yield* Effect.exit(Fiber.join(running))

      yield* network.start
      yield* TestClock.adjust("1 second")
      yield* Queue.take(network.dialled)
      yield* TestClock.adjust("2 seconds")
      const resent = yield* Queue.clear(network.requests)
      return { exit, resent }
    })
  )

describe("calls in flight when the socket drops", () => {
  it.effect("a call already written to the socket is a defect", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const { exit } = yield* dropWhileRunning(network)

      assert.isTrue(Exit.hasDies(exit))
    }))

  it.effect("a call already written to the socket is not sent again after the reconnection", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const { resent } = yield* dropWhileRunning(network)

      assert.deepStrictEqual(resent, [])
    }))
})
