import { assert, describe, it } from "@effect/vitest"
import { layerLoopLocal } from "@mufw/core"
import { Effect, Exit, Fiber, Latch, Layer, Option, Queue, Ref, Schedule, Scope, Stream } from "effect"
import { NetAddress } from "effect/net"
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc"
import { Socket, SocketServer } from "effect/socket"
import { TestClock } from "effect/testing"
import { Counter, Ports } from "../../core/test/fixtures/Counter.ts"
import { HeldRequests, layerHoldRequestsWhileDisconnected, makeRpc } from "../src/index.ts"

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
 * called is refused; `stop` also cuts the live connection. `cutNextDials(n)` makes each of the
 * next `n` dials succeed and drop at once, before anything is written to it. `requests` collects
 * the tag of every `Request` frame the client writes, `dialled` signals each successful dial,
 * `disconnected` each time the client protocol notices a lost connection.
 */
const makeNetwork = Effect.gen(function*() {
  const incoming = yield* Queue.make<Socket.Socket>()
  const dialled = yield* Queue.make<void>()
  const disconnected = yield* Queue.make<void>()
  const requests = yield* Queue.make<string>()
  const reachable = yield* Ref.make(true)
  const cuts = yield* Ref.make(0)
  const current = yield* Ref.make<Link | undefined>(undefined)
  const connected = Latch.makeUnsafe(false)

  const recordRequest = (chunk: Frame) => {
    const message = JSON.parse(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    if (message._tag !== "Request") return Effect.void
    return Queue.offer(requests, message.tag as string)
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
    const cutting = yield* Ref.modify(cuts, (remaining) => (remaining > 0 ? [true, remaining - 1] : [false, remaining]))
    if (cutting) yield* Queue.fail(toClient, connectionReset())
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
  const cutNextDials = (dials: number) => Ref.set(cuts, dials)

  const hooks = Layer.succeed(RpcClient.ConnectionHooks, {
    onConnect: Effect.void,
    onDisconnect: Effect.asVoid(Queue.offer(disconnected, undefined))
  })

  return { socket, server, hooks, requests, dialled, disconnected, stop, start, cutNextDials }
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

const clientOver = (network: Network) => clientAbove.pipe(Layer.provideMerge(protocolOver(network)))

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

/**
 * The calls `issue` starts while the socket is down, then two redials that open and drop before
 * anything is written, then a third that stays. `issue` returns the fiber that ends when its calls
 * have completed.
 */
const twoDropsAfter = <A, E, R>(network: Network, issue: Effect.Effect<Fiber.Fiber<A, E>, never, R>) =>
  Effect.gen(function*() {
    yield* Queue.take(network.dialled)
    yield* network.stop
    yield* Queue.take(network.disconnected)
    yield* TestClock.adjust("100 millis")

    const issued = yield* issue
    yield* network.cutNextDials(2)
    yield* network.start
    yield* TestClock.adjust("1 second")
    yield* TestClock.adjust("1 second")
    yield* TestClock.adjust("1 second")
    yield* TestClock.adjust("500 millis")
    return yield* Fiber.join(issued)
  })

const heldAcrossTwoDrops = <A, E, R>(network: Network, issue: Effect.Effect<Fiber.Fiber<A, E>, never, R>) =>
  overNetwork(network, twoDropsAfter(network, issue))

const currentCount = Ports.ModelPort.use((model) => Stream.runHead(model.representations)).pipe(
  Effect.map(Option.map((representation) => representation.count))
)

describe("calls held across drops of the connection", () => {
  it.effect("a call made while the socket is down survives two drops before it is written and is applied once", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const count = yield* heldAcrossTwoDrops(
        network,
        Ports.ModelPort.use((model) =>
          Effect.forkChild(model.present({ _tag: "Inc", by: 1 }).pipe(Effect.andThen(currentCount)))
        )
      )

      assert.deepStrictEqual(count, Option.some(1))
    }))

  it.effect("a call that survived two drops is written to the socket once", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const written = yield* heldAcrossTwoDrops(
        network,
        Ports.ModelPort.use((model) =>
          Effect.forkChild(model.present({ _tag: "Inc", by: 1 }).pipe(Effect.andThen(Queue.clear(network.requests))))
        )
      )

      assert.deepStrictEqual(written, ["Present"])
    }))

  it.effect("calls issued in order while disconnected are applied in that order after two drops", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const count = yield* heldAcrossTwoDrops(
        network,
        Effect.gen(function*() {
          const model = yield* Ports.ModelPort
          const increased = yield* Effect.forkChild(model.present({ _tag: "Inc", by: 2 }))
          yield* TestClock.adjust("10 millis")
          const reset = yield* Effect.forkChild(model.present({ _tag: "Reset" }))
          return yield* Effect.forkChild(
            Fiber.join(increased).pipe(Effect.andThen(Fiber.join(reset)), Effect.andThen(currentCount))
          )
        })
      )

      assert.deepStrictEqual(count, Option.some(0))
    }))
})

const heldNow = HeldRequests.useSync((held) => held).pipe(Effect.flatMap((held) => Stream.runHead(held)))

describe("the count of held calls", () => {
  it.effect("reads 1 while a call waits for the connection", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const held = yield* overNetwork(
        network,
        Effect.gen(function*() {
          const model = yield* Ports.ModelPort
          yield* Queue.take(network.dialled)
          yield* network.stop
          yield* Queue.take(network.disconnected)

          yield* Effect.forkChild(model.present({ _tag: "Inc", by: 1 }))
          yield* TestClock.adjust("300 millis")
          return yield* heldNow
        })
      )

      assert.deepStrictEqual(held, Option.some(1))
    }))

  it.effect("reads 0 again once the call is written", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const held = yield* overNetwork(
        network,
        Effect.gen(function*() {
          const model = yield* Ports.ModelPort
          yield* Queue.take(network.dialled)
          yield* network.stop
          yield* Queue.take(network.disconnected)

          const presented = yield* Effect.forkChild(model.present({ _tag: "Inc", by: 1 }))
          yield* TestClock.adjust("300 millis")
          yield* network.start
          yield* TestClock.adjust("1 second")
          yield* Queue.take(network.dialled)
          yield* TestClock.adjust("500 millis")
          yield* Fiber.join(presented)
          return yield* heldNow
        })
      )

      assert.deepStrictEqual(held, Option.some(0))
    }))

  it.effect("reads 0 when a held call is interrupted", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const held = yield* overNetwork(
        network,
        Effect.gen(function*() {
          const model = yield* Ports.ModelPort
          yield* Queue.take(network.dialled)
          yield* network.stop
          yield* Queue.take(network.disconnected)

          const presented = yield* Effect.forkChild(model.present({ _tag: "Inc", by: 1 }))
          yield* TestClock.adjust("300 millis")
          yield* Fiber.interrupt(presented)
          return yield* heldNow
        })
      )

      assert.deepStrictEqual(held, Option.some(0))
    }))

  it.effect("stays 0 while a stream subscribed during the outage waits for the connection", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const held = yield* overNetwork(
        network,
        Effect.gen(function*() {
          const model = yield* Ports.ModelPort
          yield* Queue.take(network.dialled)
          yield* network.stop
          yield* Queue.take(network.disconnected)

          yield* Effect.forkChild(Stream.runHead(model.representations))
          yield* TestClock.adjust("300 millis")
          return yield* heldNow
        })
      )

      assert.deepStrictEqual(held, Option.some(0))
    }))

  it.effect("reads 1 for a call queued behind a stream subscription that waits for the connection", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const held = yield* overNetwork(
        network,
        Effect.gen(function*() {
          const model = yield* Ports.ModelPort
          yield* Queue.take(network.dialled)
          yield* network.stop
          yield* Queue.take(network.disconnected)

          yield* Effect.forkChild(Stream.runHead(model.representations))
          yield* Effect.forkChild(model.present({ _tag: "Inc", by: 1 }))
          yield* TestClock.adjust("300 millis")
          return yield* heldNow
        })
      )

      assert.deepStrictEqual(held, Option.some(1))
    }))

  it.effect("reads 1 for a call made before the first connection has opened", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork
      yield* network.stop

      const held = yield* overNetwork(
        network,
        Effect.gen(function*() {
          const model = yield* Ports.ModelPort
          const presented = yield* Effect.forkChild(model.present({ _tag: "Inc", by: 1 }))
          yield* TestClock.adjust("300 millis")
          const pending = yield* heldNow
          yield* network.start
          yield* TestClock.adjust("1 second")
          yield* Fiber.join(presented)
          return pending
        })
      )

      assert.deepStrictEqual(held, Option.some(1))
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

describe("streams running when the socket drops", () => {
  it.effect("a representation stream written before the drop resumes through the hold layer after the reconnection", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const counts = yield* overNetwork(
        network,
        Effect.gen(function*() {
          const model = yield* Ports.ModelPort
          yield* Queue.take(network.dialled)
          const collecting = yield* Effect.forkChild(
            model.representations.pipe(Stream.map((representation) => representation.count), Stream.take(2), Stream.runCollect)
          )
          yield* Queue.take(network.requests)
          yield* network.stop
          yield* Queue.take(network.disconnected)
          yield* network.start
          yield* TestClock.adjust("1 second")
          yield* Queue.take(network.dialled)
          yield* TestClock.adjust("2 seconds")
          yield* model.present({ _tag: "Inc", by: 1 })
          return yield* Fiber.join(collecting)
        })
      )

      assert.deepStrictEqual(counts, [0, 1])
    }))
})

const directOver = <A, E, R>(network: Network, body: Effect.Effect<A, E, R | Scope.Scope>) =>
  Effect.scoped(body).pipe(Effect.provide(Layer.merge(protocolOver(network), serverOver(network))))

describe("calls of a client built with RpcClient.make over the hold layer", () => {
  it.effect("a never-written call survives two drops and is applied once", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const count = yield* directOver(
        network,
        twoDropsAfter(
          network,
          Effect.gen(function*() {
            const client = yield* RpcClient.make(Rpc.group)
            const held = yield* Effect.forkChild(client.Present({ _tag: "Inc", by: 1 }))
            return yield* Effect.forkChild(
              Fiber.join(held).pipe(
                Effect.andThen(Stream.runHead(client.Representations())),
                Effect.map(Option.map((representation) => representation.count))
              )
            )
          })
        )
      )

      assert.deepStrictEqual(count, Option.some(1))
    }))

  it.effect("a call written before the drop fails with the socket error", () =>
    Effect.gen(function*() {
      const network = yield* makeNetwork

      const exit = yield* directOver(
        network,
        Effect.gen(function*() {
          const client = yield* RpcClient.make(Rpc.group)
          yield* Queue.take(network.dialled)
          const written = yield* Effect.forkChild(Effect.exit(client.Dispatch({ _tag: "AutoReset" })))
          yield* Queue.take(network.requests)
          yield* network.stop
          yield* Queue.take(network.disconnected)
          return yield* Fiber.join(written)
        })
      )

      assert.isTrue(Exit.hasFails(exit))
    }))
})
