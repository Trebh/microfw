import { Context, Effect, Layer, Schema } from "effect"
import { EventJournal, EventLogMessage, EventLogServerUnencrypted } from "effect/eventlog"
import { Rpc, RpcClient, type RpcClientError, RpcGroup } from "effect/rpc"

/**
 * The end of the log a storage holds for the definition: the sequence of its newest entry, 0 when it
 * has none. `Storage` cannot say it, so a storage that backs a synced log provides it
 * (`layerSyncStorage`, `layerSyncStorageMemory`). Never smaller than the sequence of an entry the
 * storage has published.
 */
export class SyncHead extends Context.Service<SyncHead, { readonly last: Effect.Effect<number> }>()(
  "@mufw/core/SyncHead"
) {}

/** What `Sync.Head` answers: which log this is and where it ends, read together. */
export class LogHead extends Schema.Class<LogHead>("@mufw/core/LogHead")({
  remoteId: EventJournal.RemoteId,
  last: Schema.Natural
}) {}

/**
 * Not authenticated, as `EventLog.Hello` is: it reveals the log's id (which Hello already does) and
 * its length, and changes nothing. An authenticated call would not be retried after a reconnect that
 * forgets the session.
 */
export class HeadRpc extends Rpc.make("Sync.Head", { success: LogHead }) {}

export class SyncHeadRpcs extends RpcGroup.make(HeadRpc) {}

/** What a host serves: `RpcServer.layer(SyncRpcs)`. */
export const SyncRpcs = EventLogMessage.EventLogRemoteRpcs.merge(SyncHeadRpcs)

/**
 * The client of `SyncRpcs`. A client of the merged group is also a client of the stock group:
 * `layerSyncLogClient` hands it to `EventLogRemote` as `EventLogRemoteClient`.
 */
export class SyncClient extends Context.Service<
  SyncClient,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof SyncRpcs>, RpcClientError.RpcClientError>
>()("@mufw/core/SyncClient") {
  static readonly layer = Layer.effect(SyncClient, RpcClient.make(SyncRpcs, { disableTracing: true }))
}

/** The handler of `Sync.Head` over the `Storage` and `SyncHead` in context. */
export const layerSyncHeadHandlers = Layer.unwrap(
  Effect.gen(function*() {
    const storage = yield* EventLogServerUnencrypted.Storage
    const head = yield* SyncHead
    const answer = Effect.gen(function*() {
      const remoteId = yield* storage.getId
      const last = yield* head.last
      return new LogHead({ remoteId, last })
    })
    return SyncHeadRpcs.toLayer(Effect.succeed(SyncHeadRpcs.of({ "Sync.Head": () => answer })))
  })
)
