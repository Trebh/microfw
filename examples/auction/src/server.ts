import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { AutoActions } from "@mufw/core"
import { type RpcTag, rpcTags } from "@mufw/rpc"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { layerAuthenticationServer } from "./adapters/authenticationServer.ts"
import { layerCreditCheckTable } from "./adapters/creditCheckTable.ts"
import { layerSessionsTable } from "./adapters/sessionsTable.ts"
import { deployments, type Deployment } from "./deployments.ts"
import { Auction } from "./domain/Auction.ts"
import { layerHttpRoutes } from "./httpRoutes.ts"
import { type AuctionLoop, type AuctionStoreFailure, layerAuctionLoop } from "./persistence.ts"
import { samHttpPath, samPath } from "./samPath.ts"
import { ServerPorts, ServerRpc } from "./serverPorts.ts"
import { layerSsrRoutes } from "./ssrRoutes.ts"
import { layerStreamRoutes } from "./streamRoutes.ts"
import { checkSyncSettings, defaultAutoActions, EVENT_LOG_PATH, layerAuctionSync, SyncTarget, type SyncFailure } from "./sync.ts"

/** `pnpm build:client` writes one directory per deployment here. */
const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url))

/** The server owns model and actions; clients submit intents and read the model. */
const SERVER_OWNED: ReadonlyArray<RpcTag> = ["Submit", "Representations", "History"]

const ServerConfig = Config.all({
  /** `off` for path tests against a live server, so ticks cannot move the model. Unset: `on`, but `off` on an instance that joins a log. */
  autoActions: Config.Literals(["on", "off"], "MUFW_AUTO_ACTIONS").pipe(Config.option),
  /** Comma-separated RPC tags to serve; anything else is not routed. */
  rpcs: Config.Array(Schema.Literals(rpcTags), "MUFW_RPCS").pipe(Config.withDefault(SERVER_OWNED)),
  /** A directory: the model is loaded from it at start and persisted to it after every step. Unset: in memory. */
  store: Config.NonEmptyString("MUFW_STORE").pipe(Config.option),
  /** A built deployment: `GET /` serves its page with the view already rendered, and `/assets/*` its assets. Unset: neither. */
  ssr: Config.Literals(deployments, "MUFW_SSR").pipe(Config.option),
  /** The port to listen on. */
  port: Config.Port("MUFW_PORT").pipe(Config.withDefault(3001)),
  /** `host`: serve the event log on its own listener and share it with the instances that join; `ws://<host>:<sync port>/eventlog`: join that log. Unset: a single instance. */
  sync: Config.schema(SyncTarget, "MUFW_SYNC").pipe(Config.option),
  /** With `MUFW_SYNC=host`: the port of the event-log listener, which must differ from `MUFW_PORT`. */
  syncPort: Config.Port("MUFW_SYNC_PORT").pipe(Config.withDefault(3101)),
  /** With `MUFW_SYNC=host`: the interface of the event-log listener. Whoever reaches it can append any proposal, so the default is this machine only. */
  syncHost: Config.NonEmptyString("MUFW_SYNC_HOST").pipe(Config.withDefault("127.0.0.1"))
})

interface ServerSettings {
  readonly autoActions: boolean
  readonly rpcs: ReadonlyArray<RpcTag>
  readonly store: Option.Option<string>
  readonly ssr: Option.Option<Deployment>
  readonly sync: Option.Option<SyncTarget>
  readonly port: number
  readonly syncPort: number
  readonly syncHost: string
}

const makeServer = ({ autoActions, rpcs, store, ssr, sync, port, syncPort, syncHost }: ServerSettings) => {
  // The bidder comes from the request's session (`Authentication`), not from the layer.
  const synced = Option.map(sync, (target) => layerAuctionSync(target, { host: syncHost, port: syncPort }))
  const chosen: AuctionLoop<AuctionStoreFailure | SyncFailure> = Option.match(synced, {
    onNone: () => layerAuctionLoop(store),
    onSome: ({ loop }) => loop
  })
  const Loop = chosen.pipe(
    Layer.provide(layerCreditCheckTable),
    Layer.provide(Layer.succeed(AutoActions, autoActions))
  )
  const RpcRoutes = RpcServer.layer(ServerRpc.exposing(rpcs)).pipe(
    Layer.provide(ServerRpc.layerHandlers),
    Layer.provide(layerAuthenticationServer.pipe(Layer.provide(layerSessionsTable))),
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: samPath(Auction) })),
    Layer.provide(RpcSerialization.layerJson)
  )
  const HttpRoutes = layerHttpRoutes
  // Read-only like `HttpRoutes`: it shows what `Representations` shows, whatever `MUFW_RPCS` lets the socket serve.
  const StreamRoutes = layerStreamRoutes
  const SsrRoutes = Option.match(ssr, {
    onNone: () => Layer.empty,
    onSome: (deployment) => layerSsrRoutes({ deployment, distRoot: DIST_ROOT })
  })
  const Routes = Layer.mergeAll(RpcRoutes, HttpRoutes, StreamRoutes, SsrRoutes)
  // The loop is provided outside the router: the event-log listener below is built from the same
  // layers, and only what is built outside a router is shared with it.
  const Public = HttpRouter.serve(Routes, { disableListenLog: true }).pipe(
    Layer.provide(Loop),
    Layer.provide(NodeHttpServer.layer(createServer, { port }))
  )
  const EventLog = Option.match(synced, { onNone: () => Layer.empty, onSome: ({ eventLog }) => eventLog })
  return Layer.merge(Public, EventLog)
}

const Server = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* ServerConfig
    yield* checkSyncSettings({ sync: config.sync, store: config.store, rpcs: config.rpcs, port: config.port, syncPort: config.syncPort })
    const autoActions = Option.getOrElse(config.autoActions, () => defaultAutoActions(config.sync)) === "on"
    const store = Option.getOrElse(config.store, () => "memory")
    const ssr = Option.getOrElse(config.ssr, () => "off")
    const sync = Option.getOrElse(config.sync, () => "off")
    const hosting = Option.exists(config.sync, (target) => target === "host")
    const eventLog = hosting ? `, event log on ${config.syncHost}:${config.syncPort}${EVENT_LOG_PATH}` : ""
    const listening = Effect.log(
      `auction server listening on :${config.port}${samPath(Auction)} (auto actions ${autoActions ? "on" : "off"}, rpcs ${config.rpcs.join(",")}, store ${store}, ssr ${ssr}, sync ${sync}${eventLog}), read-only over HTTP at ${samHttpPath(Auction)}`
    )
    const settings: ServerSettings = {
      autoActions,
      rpcs: config.rpcs,
      store: config.store,
      ssr: config.ssr,
      sync: config.sync,
      port: config.port,
      syncPort: config.syncPort,
      syncHost: config.syncHost
    }
    return Layer.merge(makeServer(settings), Layer.effectDiscard(listening))
  })
)

Layer.launch(Server).pipe(NodeRuntime.runMain)
