import { NodeHttpServer, NodeSocket } from "@effect/platform-node"
import {
  layerLoopSynced,
  layerSyncAuthorization,
  layerSyncLogRemote,
  layerSyncLogStorage,
  layerSyncServer
} from "@mufw/core"
import { layerHoldRequestsWhileDisconnected, type RpcTag } from "@mufw/rpc"
import { Effect, Layer, Option, Schedule, Schema } from "effect"
import { EventLogMessage, type EventLogRemote } from "effect/eventlog"
import { HttpRouter, type HttpServerError } from "effect/http"
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"
import { Auction } from "./domain/Auction.ts"
import type { AuctionLoop } from "./persistence.ts"
import { ServerPorts } from "./serverPorts.ts"

/** Where the event-log server of the instance that hosts the log answers, on its own listener (`MUFW_SYNC_PORT`), never on the public one. */
export const EVENT_LOG_PATH = "/eventlog"

/** `host`: this process serves the log and joins it. A `ws://` or `wss://` URL of a host's `/eventlog`: this process joins it. */
export const SyncTarget = Schema.Union([
  Schema.Literal("host"),
  Schema.String.check(Schema.isPattern(/^wss?:\/\/[^/?#]+\/eventlog$/, { expected: "ws://<host>:<port>/eventlog" }))
])
export type SyncTarget = typeof SyncTarget.Type

/** `MUFW_SYNC` combined with a setting that would let an instance's model leave the log's. */
export class SyncConfigError extends Schema.TaggedError<SyncConfigError>()("SyncConfigError", {
  message: Schema.String
}) {}

/**
 * An instance that joins a log runs no automatic actions unless told to: the host's already tick
 * for every instance, and a second ticker would double them. A single instance and the host run them.
 */
export const defaultAutoActions = (sync: Option.Option<SyncTarget>): "on" | "off" =>
  Option.exists(sync, (target) => target !== "host") ? "off" : "on"

export interface SyncSettings {
  readonly sync: Option.Option<SyncTarget>
  readonly store: Option.Option<string>
  readonly rpcs: ReadonlyArray<RpcTag>
  readonly port: number
  readonly syncPort: number
}

/**
 * Refuses what a synced instance cannot honour. `MUFW_STORE` restores a model the log does not
 * know, and a late instance replays the log from its first entry on top of it. `TravelTo` moves one
 * instance's model away from the log's. The host's event log must not share the public port: the
 * writers of the public port are clients, the writers of the log are instances.
 */
export const checkSyncSettings = ({ sync, store, rpcs, port, syncPort }: SyncSettings) => {
  if (Option.isNone(sync)) return Effect.void
  if (Option.isSome(store)) {
    return Effect.fail(new SyncConfigError({ message: "MUFW_SYNC and MUFW_STORE cannot be combined: the log is the only source of the model" }))
  }
  if (rpcs.includes("TravelTo")) {
    return Effect.fail(new SyncConfigError({ message: "MUFW_SYNC does not serve TravelTo: it would move this instance's model away from the log's; remove it from MUFW_RPCS" }))
  }
  if (sync.value === "host" && syncPort === port) {
    return Effect.fail(new SyncConfigError({ message: "MUFW_SYNC_PORT must differ from MUFW_PORT: the event log is served on its own port, never the public one" }))
  }
  return Effect.void
}

/** Redial with a growing delay capped at five seconds, for as long as the process lives. */
const redialSchedule = Schedule.min([Schedule.exponential("500 millis", 1.5), Schedule.spaced("5 seconds")])

/**
 * The client protocol to a host's `/eventlog`. Entries are binary, so the connection uses
 * `SchemaBinary` serialization; a request made while the socket is down waits for the next
 * connection.
 */
const layerProtocolTo = (url: string) =>
  layerHoldRequestsWhileDisconnected.pipe(
    Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true, retryPolicy: redialSchedule })),
    Layer.provide(NodeSocket.layerWebSocket(url)),
    Layer.provide(RpcSerialization.layerSchemaBinary())
  )

/** What building the synced loop can fail with: the log server refused the handshake or the first append. */
export type SyncFailure = EventLogRemote.EventLogRemoteError

/** The auction loop over a shared log, and the listener the log is served on. */
export interface AuctionSync {
  readonly loop: AuctionLoop<SyncFailure>
  /** The event-log server on a listener of its own. Empty for an instance that joins: it opens no port. */
  readonly eventLog: Layer.Layer<never, HttpServerError.ServeError>
}

/** Where the host's event-log listener binds. */
export interface EventLogListen {
  readonly host: string
  readonly port: number
}

/**
 * The host: serves the event-log server's RPCs at `EVENT_LOG_PATH` on a router and an HTTP server
 * of their own, so that the public router never carries them, and reads and writes the log's
 * storage in-process. The routes and the loop share one storage because both are built from one
 * `server` layer, provided outside the router.
 */
const hosting = (listen: EventLogListen): AuctionSync => {
  const server = layerSyncServer(Auction).pipe(Layer.provide(layerSyncAuthorization))
  const routes = RpcServer.layer(EventLogMessage.EventLogRemoteRpcs).pipe(
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: EVENT_LOG_PATH })),
    Layer.provide(RpcSerialization.layerSchemaBinary())
  )
  const eventLog = HttpRouter.serve(routes, { disableListenLog: true }).pipe(
    Layer.provide(server),
    Layer.provide(NodeHttpServer.layer(createServer, listen))
  )
  const log = layerSyncLogStorage(Auction).pipe(Layer.provide(server))
  return { loop: layerLoopSynced(Auction, ServerPorts).pipe(Layer.provide(log)), eventLog }
}

/** An instance that reaches the host's log over the network: it serves no log. */
const joining = (url: string): AuctionSync => {
  const log = layerSyncLogRemote(Auction).pipe(Layer.provide(layerProtocolTo(url)))
  return { loop: layerLoopSynced(Auction, ServerPorts).pipe(Layer.provide(log)), eventLog: Layer.empty }
}

/** The server's auction loop over the shared log (`layerLoopSynced`) for `target`, and the listener the log is served on, which only the host `listen`s on. */
export const layerAuctionSync = (target: SyncTarget, listen: EventLogListen): AuctionSync =>
  target === "host" ? hosting(listen) : joining(target)
