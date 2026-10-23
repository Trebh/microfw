import { BrowserWorker } from "@effect/platform-browser"
import { Effect, Layer } from "effect"
import { RpcClient, RpcWorker } from "effect/rpc"
import { layerWhoamiFixed } from "../../adapters/whoamiFixed.ts"
import { layerAuthenticationAnonymous } from "../../authentication.ts"
import type { Bidder } from "../../domain/Values.ts"
import { Rpc } from "../../ports.ts"
import { layerWorkerConnection } from "../connection.ts"
import { WorkerInit } from "../workerInit.ts"

/**
 * The page's ports over a worker's RPC protocol, acting as `bidder`, which the page tells the worker
 * when it starts it. The page sends no credential: the worker acts as that bidder for every request,
 * since the page that started it is its only client. Provides `Connection`, which follows the
 * worker: `disconnected` once it raises an error event (or cannot be spawned) and until a respawned
 * one says it is ready. Needs the worker platform and a spawner.
 * Needs the worker to serve `Submit`, `Representations`, `History` (and `TravelTo` for the panel).
 */
export const workerPorts = (bidder: Bidder) => {
  // A streaming request holds its lease on the worker until it ends, so a limit of one would let the
  // first open `Representations` stream starve every other call.
  const protocol = RpcClient.layerProtocolWorker({ size: 1, concurrency: Number.MAX_SAFE_INTEGER }).pipe(
    Layer.provide(RpcWorker.layerInitialMessage(WorkerInit, Effect.succeed({ bidder }))),
    Layer.provideMerge(layerWorkerConnection)
  )
  return Layer.mergeAll(Rpc.layerIntentPortRemote, Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(
    Layer.provideMerge(Rpc.layerClient.pipe(Layer.provide(layerAuthenticationAnonymous))),
    Layer.provideMerge(protocol),
    Layer.provideMerge(layerWhoamiFixed(bidder))
  )
}

/**
 * The model and actions in a dedicated web worker started from `auctionWorker.ts`, acting as
 * `bidder`. No server. The `new Worker(new URL(...))` form is what the bundler recognises to emit
 * the worker as its own file.
 */
export const inWorker = (bidder: Bidder) =>
  workerPorts(bidder).pipe(
    Layer.provide(BrowserWorker.layer(() => new Worker(new URL("../auctionWorker.ts", import.meta.url), { type: "module" })))
  )
