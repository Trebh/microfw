import { Cause, type Deferred, Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import { KeyValueStore } from "effect/persistence"
import type { AnyDefinition, ModelOf } from "./Definition.ts"
import { layerLoopLocal } from "./Layers.ts"
import type { Ports } from "./Ports.ts"
import type { StepRecord } from "./Step.ts"
import { layerLoopSynced, LogId, type SyncCheckpoint, type SyncLogMismatch } from "./Sync.ts"
import { LeaseState, type LeaseTimings } from "./SyncLease.ts"

/**
 * Runs a store write that nothing may interrupt and that never fails the loop: a failure
 * (`KeyValueStoreError`) or a defect is logged at error level under `what`, and the next write goes on.
 */
const writeKept = <E>(write: Effect.Effect<void, E>, what: string, at: number) =>
  Effect.uninterruptible(write).pipe(
    Effect.catch((error) => Effect.logError(what, at, Cause.fail(error))),
    Effect.catchDefect((defect) => Effect.logError(what, at, Cause.die(defect)))
  )

/** The model as the store keeps it: the JSON text of `def.model`, so a stored value is parsed once, at load. */
const modelStore = <D extends AnyDefinition>(def: D) =>
  Effect.gen(function*() {
    const store = yield* KeyValueStore.KeyValueStore
    const codec: Schema.Codec<ModelOf<D>, unknown> = def.model
    return KeyValueStore.toSchemaStore(store, codec)
  })

/**
 * Reads the model stored under `key` (default: the definition's name). `none` when nothing is
 * stored. A stored text that does not decode with `def.model` fails with a `SchemaError`; it is never
 * replaced by `def.initial`, since the next step would then overwrite the stored data.
 */
export const loadModel = <D extends AnyDefinition>(
  def: D,
  key: string = def.name
): Effect.Effect<
  Option.Option<ModelOf<D>>,
  KeyValueStore.KeyValueStoreError | Schema.SchemaError,
  KeyValueStore.KeyValueStore
> => Effect.flatMap(modelStore(def), (store) => store.get(key))

/**
 * Writes the model of every record the loop commits after its initial one, steps and travels
 * alike, under `key` (default: the definition's name). The records come from `HistoryPort`, so the
 * loop never waits for the store: the permit of `layerModelLocal` is released before the write.
 *
 * Durability: the store holds the model of a recent record, last write wins. Only the newest model
 * matters, so while a write is in flight the records that commit meanwhile are coalesced into the
 * newest one: at most the write in flight and one pending record exist, however slow the store is,
 * and the intermediate models are never written. A write in flight is uninterruptible: closing the
 * layer's scope waits for it, so the store is never left with half a model by this layer. The pending
 * record is dropped when the scope closes, and a crash loses the write in flight and the pending
 * record. Whether a crash or a power loss can leave the store torn or the write lost is up to the
 * store: use an adapter that writes atomically and syncs (`layerAtomicFileStore` in `examples/auction`).
 *
 * A write that fails (`KeyValueStoreError`) is logged at error level and the next record is still
 * written: the loop is the source of truth while it runs, and a store that is down for one step may
 * accept the next, whose model supersedes the lost one. A defect is logged the same way.
 */
export const layerPersistModel = <D extends AnyDefinition, R = never>(
  def: D,
  ports: Ports<D, R>,
  key: string = def.name
) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const store = yield* modelStore(def)
      const history = yield* ports.HistoryPort
      const write = (record: StepRecord<D>) => writeKept(store.set(key, record.model), "model not persisted", record.seq)
      const newest = history.records.pipe(
        Stream.filter((record) => record.kind !== "init"),
        Stream.buffer({ capacity: 1, strategy: "sliding" })
      )
      yield* Effect.forkScoped(Stream.runForEach(newest, write))
    })
  )

/**
 * `layerLoopLocal` that starts from the model stored under `key` (default: the definition's name),
 * else from `def.initial`, and persists every later model with `layerPersistModel`. A stored value
 * that does not decode fails the layer with a `SchemaError` before the loop exists.
 */
export const layerLoopPersisted = <D extends AnyDefinition, R = never>(
  def: D,
  ports: Ports<D, R>,
  key: string = def.name
) =>
  Layer.unwrap(
    Effect.map(loadModel(def, key), (stored) => {
      const options = Option.map(stored, (initial) => ({ initial })).pipe(Option.getOrUndefined)
      return layerPersistModel(def, ports, key).pipe(Layer.provideMerge(layerLoopLocal(def, ports, options)))
    })
  )

/**
 * What a synced instance stores: its position in the log (which log, how far), the model the log's
 * entries up to there give, and the lease they give.
 */
const checkpointSchema = <D extends AnyDefinition>(def: D) => {
  const model: Schema.Codec<ModelOf<D>, unknown> = def.model
  return Schema.Struct({ log: LogId, sequence: Schema.Natural, model, lease: LeaseState })
}

const checkpointStore = <D extends AnyDefinition>(def: D) =>
  Effect.gen(function*() {
    const store = yield* KeyValueStore.KeyValueStore
    return KeyValueStore.toSchemaStore(store, checkpointSchema(def))
  })

/**
 * Reads the checkpoint stored under `key` (default: the definition's name): the id of the log, the
 * last sequence of it that the model includes, and the model. `none` when nothing is stored. A
 * stored text that does not decode fails with a `SchemaError`, which includes a model stored by
 * `layerPersistModel`: that is not the state of any log, so it is neither used nor overwritten.
 */
export const loadCheckpoint = <D extends AnyDefinition>(
  def: D,
  key: string = def.name
): Effect.Effect<
  Option.Option<SyncCheckpoint<D>>,
  KeyValueStore.KeyValueStoreError | Schema.SchemaError,
  KeyValueStore.KeyValueStore
> => Effect.flatMap(checkpointStore(def), (store) => store.get(key))

/**
 * Writes each checkpoint received from `checkpoints` under `key` (default: the definition's name),
 * coalescing as `layerPersistModel` does: the queue is sliding, so while a write is in flight only
 * the newest checkpoint waits. Writes are uninterruptible and a failed one is logged, not fatal.
 */
const layerPersistCheckpoints = <D extends AnyDefinition>(
  def: D,
  checkpoints: Queue.Dequeue<SyncCheckpoint<D>>,
  key: string
) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const store = yield* checkpointStore(def)
      const write = (checkpoint: SyncCheckpoint<D>) =>
        writeKept(store.set(key, checkpoint), "checkpoint not persisted", checkpoint.sequence)
      yield* Effect.forkScoped(Stream.runForEach(Stream.fromQueue(checkpoints), write))
    })
  )

export interface PersistedSyncOptions {
  /** Where the checkpoint is stored; the definition's name when absent. */
  readonly key?: string
  /** As `SyncOptions.stopped`. */
  readonly stopped?: Deferred.Deferred<never, SyncLogMismatch>
  /** As `SyncOptions.lease`. */
  readonly lease?: LeaseTimings
}

/**
 * `layerLoopSynced` that resumes from the checkpoint stored under `options.key` (default: the
 * definition's name), else starts from `def.initial` and the log's first entry, and stores the checkpoint after
 * every entry the loop applies. The log is the source of truth: the stored model is a cache of its
 * state at `sequence`, so an instance that restarts reads only the entries after it, and one that
 * loses its latest write reads a few more. A stored checkpoint of another log fails the layer with
 * `SyncLogMismatch`, one that does not decode with a `SchemaError`; neither is replaced. The write
 * is off the loop's permit, as in `layerPersistModel`. Requires `KeyValueStore` and `SyncLog`.
 */
export const layerLoopSyncedPersisted = <D extends AnyDefinition, R = never>(
  def: D,
  ports: Ports<D, R>,
  options?: PersistedSyncOptions
) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const key = options?.key ?? def.name
      const stored = yield* loadCheckpoint(def, key)
      const checkpoints = yield* Queue.sliding<SyncCheckpoint<D>>(1)
      const resume = Option.getOrUndefined(stored)
      const loop = layerLoopSynced(def, ports, { resume, checkpoints, stopped: options?.stopped, lease: options?.lease })
      return Layer.merge(layerPersistCheckpoints(def, checkpoints, key), loop)
    })
  )
