import { NodeSocket } from "@effect/platform-node"
import {
  layerLoopSynced,
  layerLoopSyncedPersisted,
  layerSyncAuthorization,
  layerSyncLogRemote,
  layerSyncLogStorage,
  layerSyncServer,
  layerSyncStorage,
  type SyncLog,
  type SyncLogMismatch
} from "@mufw/core/sync"
import { layerHoldRequestsWhileDisconnected, type RpcTag } from "@mufw/rpc"
import { type Deferred, Effect, Layer, Option, Schedule, Schema } from "effect"
import { EventLogMessage, type EventLogRemote, EventLogServerUnencrypted } from "effect/eventlog"
import { HttpRouter, type HttpServerError } from "effect/http"
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"
import { Auction } from "./domain/Auction.ts"
import { layerNodeServer } from "./listener.ts"
import { type AuctionLoop, type AuctionStoreFailure, type FileStore, layerFileStore } from "./persistence.ts"
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

export interface SyncSettings {
  readonly sync: Option.Option<SyncTarget>
  readonly rpcs: ReadonlyArray<RpcTag>
  readonly port: number
  readonly syncPort: number
}

/** The RPCs that change this instance's model without going through the log. */
const MODEL_REWRITING_RPCS: ReadonlyArray<RpcTag> = ["TravelTo", "Replay"]

/**
 * Refuses what a synced instance cannot honour. `TravelTo` and `Replay` move one instance's model
 * away from the log's. The host's event log must not share the public port: the writers of the
 * public port are clients, the writers of the log are instances. `MUFW_STORE` is accepted: with a
 * log it holds the instance's checkpoint (and, on the host, the log itself), not a model of its own.
 */
export const checkSyncSettings = ({ sync, rpcs, port, syncPort }: SyncSettings) => {
  if (Option.isNone(sync)) return Effect.void
  const rewriting = MODEL_REWRITING_RPCS.find((tag) => rpcs.includes(tag))
  if (rewriting !== undefined) {
    return Effect.fail(new SyncConfigError({ message: `MUFW_SYNC does not serve ${rewriting}: it would move this instance's model away from the log's; remove it from MUFW_RPCS` }))
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

/**
 * What building the synced loop can fail with: the log server refused the handshake or the first
 * append, or the log is not the one the stored checkpoint belongs to.
 */
export type SyncFailure = EventLogRemote.EventLogRemoteError | SyncLogMismatch

/** The auction loop over a shared log, and the listener the log is served on. */
export interface AuctionSync {
  readonly loop: AuctionLoop<SyncFailure | AuctionStoreFailure>
  /** The event-log server on a listener of its own. Empty for an instance that joins: it opens no port. */
  readonly eventLog: Layer.Layer<never, HttpServerError.ServeError | AuctionStoreFailure>
}

/** Where the host's event-log listener binds. */
export interface EventLogListen {
  readonly host: string
  readonly port: number
}

/** What the synced loop is built from besides the target. */
export interface AuctionSyncOptions {
  /** Where the host's event-log listener binds; an instance that joins opens none. */
  readonly listen: EventLogListen
  /** `MUFW_STORE`: a directory for this instance's checkpoint and, on the host, the log. Unset: both in memory. */
  readonly store: Option.Option<string>
  /** Fails when the loop stops applying because the log it follows is no longer the one it joined. */
  readonly stopped: Deferred.Deferred<never, SyncLogMismatch>
}

/** `AuctionLoop` that also needs the log it follows. */
type SyncedLoop<E> = Layer.Layer<Layer.Success<AuctionLoop<never>>, E, Layer.Services<AuctionLoop<never>> | SyncLog>

/**
 * The synced loop over the `SyncLog` in context: in memory, or, with a directory, resuming from the
 * checkpoint it stores there.
 */
const syncedLoop = (store: Option.Option<FileStore>, stopped: AuctionSyncOptions["stopped"]) =>
  Option.match(store, {
    onNone: (): SyncedLoop<SyncFailure> => layerLoopSynced(Auction, ServerPorts, { stopped }),
    onSome: (files): SyncedLoop<SyncFailure | AuctionStoreFailure> =>
      layerLoopSyncedPersisted(Auction, ServerPorts, { stopped }).pipe(Layer.provide(files))
  })

/**
 * The host: serves the event-log server's RPCs at `EVENT_LOG_PATH` on a router and an HTTP server
 * of their own, so that the public router never carries them, and reads and writes the log's
 * storage in-process. The routes and the loop share one storage because both are built from one
 * `server` layer, provided outside the router. With a store directory the log is persisted in it
 * (`layerSyncStorage`), so it survives a restart of the host together with its id; without one it
 * lives in memory and a restart starts a new log.
 */
const hosting = ({ listen, store, stopped }: AuctionSyncOptions): AuctionSync => {
  const files = Option.map(store, layerFileStore)
  const storage = Option.match(files, {
    onNone: () => EventLogServerUnencrypted.layerStorageMemory,
    onSome: (kv) => layerSyncStorage(Auction).pipe(Layer.provide(kv))
  })
  const server = layerSyncServer(Auction).pipe(Layer.provide(layerSyncAuthorization), Layer.provideMerge(storage))
  const routes = RpcServer.layer(EventLogMessage.EventLogRemoteRpcs).pipe(
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: EVENT_LOG_PATH })),
    Layer.provide(RpcSerialization.layerSchemaBinary())
  )
  const eventLog = HttpRouter.serve(routes, { disableListenLog: true }).pipe(
    Layer.provide(server),
    Layer.provide(layerNodeServer(createServer, listen))
  )
  const log = layerSyncLogStorage(Auction).pipe(Layer.provide(server))
  return { loop: syncedLoop(files, stopped).pipe(Layer.provide(log)), eventLog }
}

/**
 * An instance that reaches the host's log over the network: it serves no log. With a store
 * directory it keeps its checkpoint there and, after a restart, reads only the entries after it.
 */
const joining = (url: string, { store, stopped }: AuctionSyncOptions): AuctionSync => {
  const log = layerSyncLogRemote(Auction).pipe(Layer.provide(layerProtocolTo(url)))
  const files = Option.map(store, layerFileStore)
  return { loop: syncedLoop(files, stopped).pipe(Layer.provide(log)), eventLog: Layer.empty }
}

/** The server's auction loop over the shared log (`layerLoopSynced`) for `target`, and the listener the log is served on, which only the host opens. */
export const layerAuctionSync = (target: SyncTarget, options: AuctionSyncOptions): AuctionSync =>
  target === "host" ? hosting(options) : joining(target, options)
