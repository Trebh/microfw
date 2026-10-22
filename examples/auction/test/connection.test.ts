import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { TestClock } from "effect/testing"
import { Connection, layerProtocol } from "../src/client/connection.ts"

const openRefused = () =>
  new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause: "refused" }) })
const connectionLost = () => new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1006 }) })

/** A socket to a server that can be taken down and brought back; a dial while it is down is refused. */
const makeServer = Effect.gen(function*() {
  const reachable = yield* Ref.make(true)
  const open = yield* Ref.make<ReadonlyArray<Deferred.Deferred<never, Socket.SocketError>>>([])
  const socket = Socket.make({
    reader: Effect.gen(function*() {
      if (!(yield* Ref.get(reachable))) return yield* Effect.fail(openRefused())
      const closed = yield* Deferred.make<never, Socket.SocketError>()
      yield* Ref.update(open, (all) => [...all, closed])
      return { pull: Deferred.await(closed), upgrade: () => Effect.void }
    }),
    writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void })
  })
  const stop = Effect.gen(function*() {
    yield* Ref.set(reachable, false)
    const connections = yield* Ref.getAndSet(open, [])
    yield* Effect.forEach(connections, (closed) => Deferred.fail(closed, connectionLost()))
  })
  const start = Ref.set(reachable, true)
  return { socket, stop, start }
})

type Server = Effect.Success<typeof makeServer>

/** Runs `body` with the client protocol dialled over `server`; `Connection` is the protocol's. */
const overServer = <A>(server: Server, body: Effect.Effect<A, never, never>) =>
  body.pipe(
    Effect.provide(
      layerProtocol.pipe(
        Layer.provide(Layer.merge(Layer.succeed(Socket.Socket, server.socket), RpcSerialization.layerJson))
      )
    )
  )

const reaches = (state: "connected" | "disconnected") =>
  Connection.useSync((states) => states).pipe(
    Effect.flatMap((states) => states.pipe(Stream.filter((s) => s === state), Stream.runHead))
  )

describe("connection status", () => {
  it.effect("is disconnected when the server is down at page load", () =>
    Effect.gen(function*() {
      const server = yield* makeServer
      yield* server.stop

      const state = yield* overServer(server, reaches("disconnected"))

      assert.deepStrictEqual(state, Option.some("disconnected"))
    }))

  it.effect("is disconnected when an open connection is lost", () =>
    Effect.gen(function*() {
      const server = yield* makeServer

      const state = yield* overServer(
        server,
        Effect.gen(function*() {
          yield* reaches("connected")
          yield* server.stop
          return yield* reaches("disconnected")
        })
      )

      assert.deepStrictEqual(state, Option.some("disconnected"))
    }))

  it.effect("is connected again once the server is back", () =>
    Effect.gen(function*() {
      const server = yield* makeServer

      const state = yield* overServer(
        server,
        Effect.gen(function*() {
          yield* reaches("connected")
          yield* server.stop
          yield* reaches("disconnected")
          yield* server.start
          const back = yield* Effect.forkChild(reaches("connected"))
          yield* TestClock.adjust("5 seconds")
          return yield* Fiber.join(back)
        })
      )

      assert.deepStrictEqual(state, Option.some("connected"))
    }))
})
