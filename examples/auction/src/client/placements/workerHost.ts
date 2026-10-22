import type { RpcTag } from "@mufw/rpc"
import { Effect, Layer } from "effect"
import { RpcServer, RpcWorker } from "effect/rpc"
import { layerAuthenticationFixed } from "../../adapters/authenticationFixed.ts"
import { ServerRpc } from "../../serverPorts.ts"
import { WorkerInit } from "../workerInit.ts"
import { auctionLoopLocal } from "./auctionLocal.ts"

/**
 * What the page in front of the worker calls. `Present` and `Dispatch` stay unrouted: the page
 * never proposes to the model or runs actions itself, and an RPC nobody needs is one less way in.
 */
const WORKER_RPCS: ReadonlyArray<RpcTag> = ["Submit", "Representations", "History", "TravelTo"]

const serve = (init: typeof WorkerInit.Type) =>
  RpcServer.layer(ServerRpc.exposing(WORKER_RPCS)).pipe(
    Layer.provide(ServerRpc.layerHandlers),
    Layer.provide(auctionLoopLocal()),
    Layer.provide(layerAuthenticationFixed(init.bidder))
  )

/**
 * The auction's model and actions behind the worker's RPC protocol. The first message the page sends
 * is its `WorkerInit`; it is decoded before anything is served, and a message that does not decode
 * fails the layer. Needs a `WorkerRunnerPlatform`: the worker's global scope, or a message port.
 */
export const workerHost = Layer.unwrap(Effect.map(RpcWorker.initialMessage(WorkerInit), serve)).pipe(
  Layer.provide(RpcServer.layerProtocolWorkerRunner)
)
