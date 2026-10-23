import { Context, Effect, Exit, Layer, Option, Scope, Stream } from "effect"
import { EventLogMessage, EventLogRemote, EventLogServerUnencrypted } from "effect/eventlog"
import { KeyValueStore } from "effect/persistence"
import { RpcTest } from "effect/rpc"
import {
  AutoActions,
  type HistoryPortShape,
  layerLoopSynced,
  layerSyncAuthorization,
  layerSyncLogClient,
  layerSyncLogStorage,
  layerSyncServer,
  type ModelPortShape,
  SyncLog,
  type SyncOptions
} from "../../src/index.ts"
import { collect } from "../support.ts"
import { Counter, Ports } from "./Counter.ts"

/**
 * One log server over `storage` (the event-log RPC handlers) and the two ways an instance reaches
 * it: the server's own process reads and writes its storage; another process is an event-log
 * client over an in-process connection to the handlers.
 */
export const harnessOver = <E, R>(storage: Layer.Layer<EventLogServerUnencrypted.Storage, E, R>) =>
  Effect.gen(function*() {
    const server = layerSyncServer(Counter).pipe(Layer.provide(layerSyncAuthorization), Layer.provideMerge(storage))
    const built = Layer.succeedContext(yield* Layer.build(server))
    const rpcClient = Layer.effect(
      EventLogRemote.EventLogRemoteClient,
      RpcTest.makeClient(EventLogMessage.EventLogRemoteRpcs)
    )
    return {
      hostLog: layerSyncLogStorage(Counter).pipe(Layer.provide(built)),
      clientLog: layerSyncLogClient(Counter).pipe(Layer.provide(rpcClient), Layer.provide(built))
    }
  })

/** A log server whose storage lives in memory. */
export const harness = harnessOver(EventLogServerUnencrypted.layerStorageMemory)

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

/** The id and the entries (sequence and event) a log delivers from `from`, as far as it holds them now. */
export const readLog = <E, R>(log: Layer.Layer<SyncLog, E, R>, from: number) =>
  Effect.gen(function*() {
    const sync = Context.get(yield* Layer.build(log), SyncLog)
    const subscription = yield* sync.follow(from)
    const entries = yield* collect(Stream.orDie(subscription.entries))
    return { log: subscription.log, entries }
  })

/** A key-value store that outlives what is built over it, as a directory outlives a process. */
export const sharedStore = Layer.build(Layer.fresh(KeyValueStore.layerMemory)).pipe(
  Effect.map((context) => Layer.succeedContext(context))
)
