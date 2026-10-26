import { NodeRuntime, NodeSocket } from "@effect/platform-node"
import { createTestModel } from "@mufw/test"
import { Config, Console, Effect, Layer } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Wallet } from "../src/wallet/Wallet.ts"
import { WalletPorts, WalletRpc } from "../src/ports.ts"
import { samPath } from "../src/samPath.ts"
import { walletTestModel } from "./wallet/Wallet.pathModel.ts"

/**
 * Replays the wallet's shortest paths against the second definition a live server serves, at
 * `/sam/wallet`. Every path travels to seq 0 and expects `Wallet.initial` there, which the server's
 * wallet has from the start: it is in memory and neither persisted nor synced. The server must
 * serve `Present`, `Representations`, `History` and `TravelTo`, which `pnpm dev:server` does.
 */
const ServerOrigin = Config.String("MUFW_SERVER").pipe(Config.withDefault("ws://localhost:3001"))

const model = createTestModel(Wallet, WalletPorts, walletTestModel)

const Socket = Layer.unwrap(
  Effect.gen(function*() {
    return NodeSocket.layerWebSocket(`${yield* ServerOrigin}${samPath(Wallet)}`)
  })
)

const Remote = Layer.merge(WalletRpc.layerModelRemote, WalletRpc.layerHistoryRemote).pipe(
  Layer.provide(WalletRpc.layerClient),
  Layer.provide(RpcClient.layerProtocolSocket()),
  Layer.provide(Socket),
  Layer.provide(RpcSerialization.layerJson)
)

const replayPaths = Effect.forEach(
  model.shortestPaths(),
  (path) => model.run(path).pipe(Effect.andThen(Console.log(`ok ${model.describe(path)}`))),
  { discard: true }
).pipe(
  Effect.tapError((failure) => Console.error(`not ok ${failure.target} at step ${failure.stepIndex}: ${failure.message}`))
)

NodeRuntime.runMain(replayPaths.pipe(Effect.provide(Remote)))
