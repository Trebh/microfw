import { Context, Effect, Exit, Layer, Option, Scope, Stream } from "effect"
import { EventJournal, type EventLogServerUnencrypted } from "effect/eventlog"
import { KeyValueStore } from "effect/persistence"
import { RpcTest } from "effect/rpc"
import { AutoActions, type HistoryPortShape, type ModelPortShape } from "../../src/index.ts"
import {
  layerLoopSynced,
  layerSyncAuthorization,
  layerSyncLogClient,
  layerSyncLogStorage,
  layerSyncServer,
  layerSyncStorage,
  layerSyncStorageMemory,
  SyncClient,
  type SyncHead,
  SyncLog,
  type SyncOptions,
  SyncRpcs
} from "../../src/SyncEntry.ts"
import { collect } from "../support.ts"
import { Counter, Ports } from "./Counter.ts"

/**
 * One log server over `storage` (the event-log RPC handlers and `Sync.Head`) and the two ways an
 * instance reaches it: the server's own process reads and writes its storage; another process is
 * an event-log client over an in-process connection to the handlers. `syncClient` is that
 * connection's client itself, for what a test asks the server directly, and `server` is the
 * context the handlers were built over, for the services of the storage (`SyncStorageCut`).
 * `authorization` is what the server asks before it stores a client's entries.
 */
export const harnessOver = <E, R>(
  storage: Layer.Layer<EventLogServerUnencrypted.Storage | SyncHead, E, R>,
  authorization: Layer.Layer<EventLogServerUnencrypted.EventLogServerAuthorization> = layerSyncAuthorization
) =>
  Effect.gen(function*() {
    const server = layerSyncServer(Counter).pipe(Layer.provide(authorization), Layer.provideMerge(storage))
    const built = Layer.succeedContext(yield* Layer.build(server))
    const rpcClient = Layer.effect(SyncClient, RpcTest.makeClient(SyncRpcs))
    return {
      hostLog: layerSyncLogStorage(Counter).pipe(Layer.provide(built)),
      clientLog: layerSyncLogClient(Counter).pipe(Layer.provide(rpcClient), Layer.provide(built)),
      syncClient: yield* RpcTest.makeClient(SyncRpcs).pipe(Effect.provide(built)),
      server: built
    }
  })

/** A log server whose storage lives in memory. */
export const harness = harnessOver(layerSyncStorageMemory(Counter))

/** A log server whose storage lives in a key-value store in memory, the one a host can cut. */
export const cuttingHarness = harnessOver(layerSyncStorage(Counter).pipe(Layer.provide(KeyValueStore.layerMemory)))

/** One boot of a host over `store`: its own scope, which closing ends the host, the store staying. */
export const bootOver = <E, R>(store: Layer.Layer<KeyValueStore.KeyValueStore, E, R>) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const host = yield* harnessOver(layerSyncStorage(Counter).pipe(Layer.provide(store))).pipe(Scope.provide(scope))
    return { ...host, stop: Scope.close(scope, Exit.void) }
  })

/** A `Joined` entry with an id made of `millis`: any entry a log accepts, to fill it up to a size. */
export const joinedEntry = (millis: number) =>
  new EventJournal.Entry({
    id: EventJournal.makeEntryIdUnsafe({ msecs: millis }),
    event: "Joined",
    primaryKey: Counter.name,
    payload: new Uint8Array()
  }, { disableChecks: true })

/**
 * Removes the newest stored segment of a 300-entry log (`<name>/log/1`, sequences 257 and later),
 * as a store that lost its newest writes would: the log keeps its id and ends at sequence 256.
 */
export const losingNewestSegment = <E, R>(store: Layer.Layer<KeyValueStore.KeyValueStore, E, R>) =>
  Effect.gen(function*() {
    const kv = Context.get(yield* Layer.build(store), KeyValueStore.KeyValueStore)
    yield* kv.remove(`${Counter.name}/log/1`)
  })

export interface Instance {
  readonly model: ModelPortShape<typeof Counter>
  readonly history: HistoryPortShape<typeof Counter>
}

/** The Counter's synced loop over `log`; the layers it needs besides the log are provided here. */
export const loopOn = <E, R>(
  log: Layer.Layer<SyncLog, E, R>,
  autoActions: boolean,
  options?: SyncOptions<typeof Counter>
) => layerLoopSynced(Counter, Ports, options).pipe(Layer.provide(log), Layer.provide(Layer.succeed(AutoActions, autoActions)))

export const instanceOn = <E, R>(
  log: Layer.Layer<SyncLog, E, R>,
  autoActions: boolean,
  options?: SyncOptions<typeof Counter>
) =>
  Layer.build(loopOn(log, autoActions, options)).pipe(
    Effect.map((context): Instance => ({
      model: Context.get(context, Ports.ModelPort),
      history: Context.get(context, Ports.HistoryPort)
    }))
  )

/** As `instanceOn`, in a scope of its own: `stop` closes it, as a stopped process closes its layers. */
export const stoppableOn = <E, R>(
  log: Layer.Layer<SyncLog, E, R>,
  autoActions: boolean,
  options?: SyncOptions<typeof Counter>
) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const context = yield* Layer.build(loopOn(log, autoActions, options)).pipe(Scope.provide(scope))
    const instance: Instance = {
      model: Context.get(context, Ports.ModelPort),
      history: Context.get(context, Ports.HistoryPort)
    }
    return { instance, stop: Scope.close(scope, Exit.void) }
  })

export const currentRepresentation = (instance: Instance) =>
  Stream.runHead(instance.model.representations).pipe(Effect.map(Option.getOrThrow))

export const countIs = (count: number) => (representation: { readonly count: number }) => representation.count === count

/** The count of every record the instance holds, the initial one first. */
export const countsOf = (instance: Instance) =>
  collect(instance.history.records).pipe(Effect.map((records) => records.map((record) => record.model.count)))

/** The kind of every record the instance holds, the initial one first. */
export const kindsOf = (instance: Instance) =>
  collect(instance.history.records).pipe(Effect.map((records) => records.map((record) => record.kind)))

/** The id, the last sequence and the entries (sequence and event) a log delivers from `from`, as far as it holds them now. */
export const readLog = <E, R>(log: Layer.Layer<SyncLog, E, R>, from: number) =>
  Effect.gen(function*() {
    const sync = Context.get(yield* Layer.build(log), SyncLog)
    const subscription = yield* sync.follow(from)
    const entries = yield* collect(Stream.orDie(subscription.entries))
    return { log: subscription.log, last: subscription.last, entries }
  })

/** A key-value store that outlives what is built over it, as a directory outlives a process. */
export const sharedStore = Layer.build(Layer.fresh(KeyValueStore.layerMemory)).pipe(
  Effect.map((context) => Layer.succeedContext(context))
)
