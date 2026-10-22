import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { AutoActions, layerLoopLocal } from "@mufw/core"
import { type RpcTag, rpcTags } from "@mufw/rpc"
import { Config, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"
import { layerAuthenticationServer } from "./adapters/authenticationServer.ts"
import { layerCreditCheckTable } from "./adapters/creditCheckTable.ts"
import { layerSessionsTable } from "./adapters/sessionsTable.ts"
import { Auction } from "./domain/Auction.ts"
import { ServerPorts, ServerRpc } from "./serverPorts.ts"

const PORT = 3001

/** The server owns model and actions; clients submit intents and read the model. */
const SERVER_OWNED: ReadonlyArray<RpcTag> = ["Submit", "Representations", "History"]

const ServerConfig = Config.all({
  /** `off` for path tests against a live server, so ticks cannot move the model. */
  autoActions: Config.Literals(["on", "off"], "MUFW_AUTO_ACTIONS").pipe(Config.withDefault("on")),
  /** Comma-separated RPC tags to serve; anything else is not routed. */
  rpcs: Config.Array(Schema.Literals(rpcTags), "MUFW_RPCS").pipe(Config.withDefault(SERVER_OWNED))
})

const makeServer = (autoActions: boolean, rpcs: ReadonlyArray<RpcTag>) => {
  // The bidder comes from the request's session (`Authentication`), not from the layer.
  const Loop = layerLoopLocal(Auction, ServerPorts).pipe(
    Layer.provide(layerCreditCheckTable),
    Layer.provide(Layer.succeed(AutoActions, autoActions))
  )
  const RpcRoutes = RpcServer.layer(ServerRpc.exposing(rpcs)).pipe(
    Layer.provide(ServerRpc.layerHandlers),
    Layer.provide(Loop),
    Layer.provide(layerAuthenticationServer.pipe(Layer.provide(layerSessionsTable))),
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/sam" })),
    Layer.provide(RpcSerialization.layerJson)
  )
  return HttpRouter.serve(RpcRoutes, { disableListenLog: true }).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port: PORT }))
  )
}

const Server = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* ServerConfig
    const autoActions = config.autoActions === "on"
    const listening = Effect.log(
      `auction server listening on :${PORT} (auto actions ${config.autoActions}, rpcs ${config.rpcs.join(",")})`
    )
    return Layer.merge(makeServer(autoActions, config.rpcs), Layer.effectDiscard(listening))
  })
)

Layer.launch(Server).pipe(NodeRuntime.runMain)
