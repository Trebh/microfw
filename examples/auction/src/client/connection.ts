import { layerHoldRequestsWhileDisconnected } from "@mufw/rpc"
import { Context, Effect, Layer, Schedule, Stream, SubscriptionRef } from "effect"
import { RpcClient } from "effect/rpc"
import { Worker } from "effect/workers"

export type ConnectionState = "connecting" | "connected" | "disconnected"

/**
 * The transport's state as data, apart from the SAM representation. A page with no remote port
 * provides nothing and reads the default: always connected.
 */
export const Connection = Context.Reference<Stream.Stream<ConnectionState>>("auction/Connection", {
  defaultValue: () => Stream.make("connected")
})

/** Redial with a growing delay capped at five seconds, for as long as the page lives. */
export const reconnectSchedule = Schedule.min([Schedule.exponential("500 millis", 1.5), Schedule.spaced("5 seconds")])

/**
 * The protocol reports each dial's outcome through `ConnectionHooks`; `disconnected` is also
 * reported when a dial never opened, so a page loaded while the server is down shows it.
 */
export const layerConnectionHooks = Layer.effectContext(
  SubscriptionRef.make<ConnectionState>("connecting").pipe(
    Effect.map((state) =>
      Context.make(Connection, SubscriptionRef.changes(state)).pipe(
        Context.add(RpcClient.ConnectionHooks, {
          onConnect: SubscriptionRef.set(state, "connected"),
          onDisconnect: SubscriptionRef.set(state, "disconnected")
        })
      )
    )
  )
)

/**
 * The client protocol over the socket in context: it redials on `reconnectSchedule`, and a dial
 * that cannot open leaves calls pending instead of failing them. A request made after an open
 * connection dropped waits for the next one (`layerHoldRequestsWhileDisconnected`). `Connection`
 * follows the socket.
 */
export const layerProtocol = layerHoldRequestsWhileDisconnected.pipe(
  Layer.provide(RpcClient.layerProtocolSocket({
    retryTransientErrors: true,
    retryPolicy: reconnectSchedule
  })),
  Layer.provideMerge(layerConnectionHooks)
)

type ConnectionRef = SubscriptionRef.SubscriptionRef<ConnectionState>

/**
 * A worker's `run` lives as long as the worker does and ends only by failing, so its exit is the
 * disconnect. Readiness is the `onSpawn` hook, which the platform runs when the worker says it is up
 * and the protocol has sent its initial message. A retry of `run` keeps `disconnected` until then,
 * so a worker that fails on every spawn does not flicker through `connecting`.
 */
const watchWorker = <O, I>(state: ConnectionRef, worker: Worker.Worker<O, I>): Worker.Worker<O, I> => ({
  send: worker.send,
  run: (handler, options) => {
    const onSpawn = Effect.andThen(options?.onSpawn ?? Effect.void, SubscriptionRef.set(state, "connected"))
    return worker.run(handler, { onSpawn }).pipe(
      Effect.onExit(() => SubscriptionRef.set(state, "disconnected"))
    )
  }
})

/**
 * The worker platform in context, reporting each worker it spawns as `Connection`. The protocol
 * (`RpcClient.layerProtocolWorker`) calls `ConnectionHooks.onConnect` before the worker exists and
 * never `onDisconnect`, so it is the platform that sees the worker's real state: the `error` event
 * of the worker, or a spawn that throws, ends `run` and reads `disconnected`; the next `run`, after
 * the protocol's retry, reads `connected` once the worker is ready again.
 */
export const layerWorkerConnection = Layer.effectContext(
  Effect.gen(function*() {
    const platform = yield* Worker.WorkerPlatform
    const state = yield* SubscriptionRef.make<ConnectionState>("connecting")
    const watched = Worker.WorkerPlatform.of({
      spawn: <O, I>(id: number) => Effect.map(platform.spawn<O, I>(id), (worker) => watchWorker(state, worker))
    })
    return Context.make(Worker.WorkerPlatform, watched).pipe(
      Context.add(Connection, SubscriptionRef.changes(state))
    )
  })
)
