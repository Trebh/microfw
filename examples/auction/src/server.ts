import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { AutoActions, layerLoopLocal } from "@mufw/core"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"
import { Auction } from "./domain/Auction.ts"
import { CreditCheck } from "./domain/CreditCheck.ts"
import { Ports, Rpc } from "./ports.ts"

const PORT = 3001

/** Path tests against a live server start it with `MUFW_AUTO_ACTIONS=off`, so ticks cannot move the model. */
const autoActions = process.env.MUFW_AUTO_ACTIONS !== "off"

const Loop = layerLoopLocal(Auction, Ports).pipe(
  Layer.provide(CreditCheck.layerLive),
  Layer.provide(Layer.succeed(AutoActions, autoActions))
)

const RpcRoutes = RpcServer.layer(Rpc.group).pipe(
  Layer.provide(Rpc.layerHandlers),
  Layer.provide(Loop),
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/sam" })),
  Layer.provide(RpcSerialization.layerJson)
)

const Listening = Layer.effectDiscard(
  Effect.log(`auction server listening on :${PORT} (auto actions ${autoActions ? "on" : "off"})`)
)

const Server = HttpRouter.serve(RpcRoutes, { disableListenLog: true }).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: PORT }))
)

Layer.launch(Layer.merge(Server, Listening)).pipe(NodeRuntime.runMain)
