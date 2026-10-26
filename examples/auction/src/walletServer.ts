import { layerLoopLocal } from "@mufw/core"
import type { RpcTag } from "@mufw/rpc"
import { Layer } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { Wallet } from "./wallet/Wallet.ts"
import { WalletPorts, WalletRpc } from "./ports.ts"
import { samPath } from "./samPath.ts"

/**
 * The wallet the server serves: one in-memory model of its own, shared by every client of
 * `/sam/wallet`. No page reads it (the pages keep their browser wallet) and it is neither persisted
 * nor synced, so it starts from `Wallet.initial` with every start of the process.
 */
export const layerWalletLoop = layerLoopLocal(Wallet, WalletPorts)

/**
 * The wallet's RPCs of `rpcs` on its own websocket path, `/sam/wallet`. Its actions read no
 * `CurrentBidder`, so no authentication stands in front of them. Needs `layerWalletLoop` and an
 * `HttpRouter`.
 */
export const layerWalletRoutes = (rpcs: ReadonlyArray<RpcTag>) =>
  RpcServer.layer(WalletRpc.exposing(rpcs)).pipe(
    Layer.provide(WalletRpc.layerHandlers),
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: samPath(Wallet) })),
    Layer.provide(RpcSerialization.layerJson)
  )
