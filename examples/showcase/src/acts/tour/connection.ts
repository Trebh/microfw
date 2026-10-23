import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect"
import { Worker } from "effect/workers"

export type ConnectionState = "connecting" | "connected" | "disconnected"

/**
 * The worker's state as data, apart from the SAM representation. A stage with no worker provides
 * nothing and reads the default: always connected.
 */
export const Connection = Context.Reference<Stream.Stream<ConnectionState>>("showcase/tour/Connection", {
  defaultValue: () => Stream.make("connected")
})

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
