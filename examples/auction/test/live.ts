import { NodeRuntime, NodeSocket } from "@effect/platform-node"
import { createTestModel } from "@mufw/test"
import { Console, Effect, Layer } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Auction } from "../src/domain/Auction.ts"
import { Ports, Rpc } from "../src/ports.ts"
import { auctionTestModel } from "./model.ts"

/**
 * Replays the auction's shortest paths against a live server, which must run with
 * `MUFW_AUTO_ACTIONS=off` so ticks cannot move the model between asserted steps.
 */
const url = process.env.MUFW_SERVER ?? "ws://localhost:3001/sam"

const model = createTestModel(Auction, Ports, auctionTestModel)

const RemoteModel = Layer.merge(Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(
  Layer.provide(Rpc.layerClient),
  Layer.provide(RpcClient.layerProtocolSocket()),
  Layer.provide(NodeSocket.layerWebSocket(url)),
  Layer.provide(RpcSerialization.layerJson)
)

const program = Effect.forEach(
  model.shortestPaths(),
  (path) => model.run(path).pipe(Effect.andThen(Console.log(`ok ${model.describe(path)}`))),
  { discard: true }
).pipe(
  Effect.tapError((failure) => Console.error(`not ok ${failure.target} at step ${failure.stepIndex}: ${failure.message}`)),
  Effect.provide(RemoteModel)
)

NodeRuntime.runMain(program)
