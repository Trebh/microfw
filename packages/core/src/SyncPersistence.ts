import { type Deferred, Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import { KeyValueStore } from "effect/persistence"
import type { AnyDefinition, ModelOf } from "./Definition.ts"
import type { Ports } from "./Ports.ts"
import { writeKept } from "./StoreWrite.ts"
import { layerLoopSynced, LogId, type SyncCheckpoint, type SyncLogMismatch } from "./Sync.ts"
import { LeaseState, type LeaseTimings } from "./SyncLease.ts"

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
