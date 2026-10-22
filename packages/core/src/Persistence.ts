import { Cause, Effect, Layer, Option, Stream } from "effect"
import type { Schema } from "effect"
import { KeyValueStore } from "effect/persistence"
import type { AnyDefinition, ModelOf } from "./Definition.ts"
import { layerLoopLocal } from "./Layers.ts"
import type { Ports } from "./Ports.ts"
import type { StepRecord } from "./Step.ts"

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
 * record; there is no flush. A store whose `set` is not atomic can still be left torn by a crash
 * mid-write: use an adapter that is (`layerAtomicFileStore` in `examples/auction`).
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
      const write = (record: StepRecord<D>) =>
        Effect.uninterruptible(store.set(key, record.model)).pipe(
          Effect.catch((error) => Effect.logError("model not persisted", record.seq, Cause.fail(error))),
          Effect.catchDefect((defect) => Effect.logError("model not persisted", record.seq, Cause.die(defect)))
        )
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
