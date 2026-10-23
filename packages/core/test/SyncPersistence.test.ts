import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { KeyValueStore } from "effect/persistence"
import { AutoActions } from "../src/index.ts"
import { layerLoopSyncedPersisted, LogId, type SyncLog } from "../src/SyncEntry.ts"
import { Counter, Ports } from "./fixtures/Counter.ts"
import {
  countsOf,
  harness,
  type Instance,
  instanceOn,
  readLog,
  sharedStore
} from "./fixtures/SyncHarness.ts"
import { captureLogs, settle } from "./support.ts"

const inc = (by: number) => ({ _tag: "Inc", by }) as const

/** The persisted synced loop over `log` and `store`, in a scope of its own that closing stops. */
const persistedOn = <E1, R1, E2, R2>(
  log: Layer.Layer<SyncLog, E1, R1>,
  store: Layer.Layer<KeyValueStore.KeyValueStore, E2, R2>
) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const layer = layerLoopSyncedPersisted(Counter, Ports).pipe(
      Layer.provide(log),
      Layer.provide(store),
      Layer.provide(Layer.succeed(AutoActions, false))
    )
    const context = yield* Layer.build(layer).pipe(Scope.provide(scope))
    const instance: Instance = {
      model: Context.get(context, Ports.ModelPort),
      history: Context.get(context, Ports.HistoryPort)
    }
    return { instance, stop: Scope.close(scope, Exit.void) }
  })

const storedText = (store: Layer.Layer<KeyValueStore.KeyValueStore>) =>
  Effect.gen(function*() {
    const kv = Context.get(yield* Layer.build(store), KeyValueStore.KeyValueStore)
    return yield* kv.get(Counter.name)
  })

describe("layerLoopSyncedPersisted", () => {
  it.effect("stores the log's id, the last applied sequence and the model after an entry is applied", () =>
    Effect.gen(function*() {
      const { clientLog } = yield* harness
      const store = yield* sharedStore
      const { instance } = yield* persistedOn(clientLog, store)

      yield* instance.model.present(inc(2))
      yield* settle

      const { log } = yield* readLog(clientLog, 0)
      assert.deepStrictEqual(JSON.parse((yield* storedText(store)) ?? "null"), {
        log,
        sequence: 2,
        model: { count: 2 },
        lease: { epoch: 0, holder: null }
      })
    }))

  it.effect("restarts from its stored checkpoint and applies only the entries after it", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const store = yield* sharedStore
      const a = yield* instanceOn(hostLog, false)
      const first = yield* persistedOn(clientLog, store)
      yield* a.model.present(inc(2))
      yield* settle
      yield* first.stop
      yield* a.model.present(inc(3))

      const restarted = yield* persistedOn(clientLog, store)

      assert.deepStrictEqual(yield* countsOf(restarted.instance), [2, 5])
    }))

  it.effect("ends equal to an instance that replays the whole log", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const store = yield* sharedStore
      const a = yield* instanceOn(hostLog, false)
      const first = yield* persistedOn(clientLog, store)
      yield* a.model.present(inc(2))
      yield* settle
      yield* first.stop
      yield* a.model.present(inc(3))

      const restarted = yield* persistedOn(clientLog, store)
      const replayed = yield* instanceOn(clientLog, false)

      assert.deepStrictEqual(yield* countsOf(replayed), [0, 2, 5])
      assert.deepStrictEqual(
        (yield* countsOf(restarted.instance)).at(-1),
        (yield* countsOf(replayed)).at(-1)
      )
    }))

  it.effect("fails with SyncLogMismatch over a checkpoint of another log, and leaves the stored text as it was", () =>
    Effect.gen(function*() {
      const { clientLog } = yield* harness
      const store = yield* sharedStore
      const kv = Context.get(yield* Layer.build(store), KeyValueStore.KeyValueStore)
      const foreign = LogId.make("0123456789abcdef0123456789abcdef")
      const text = JSON.stringify({ log: foreign, sequence: 1, model: { count: 1 }, lease: { epoch: 0, holder: null } })
      yield* kv.set(Counter.name, text)

      const error = yield* Effect.flip(persistedOn(clientLog, store))

      assert.strictEqual(error._tag, "SyncLogMismatch")
      assert.strictEqual(yield* storedText(store), text)
    }))

  it.effect("fails with a SchemaError over a stored model that is not a checkpoint, and leaves it as it was", () =>
    Effect.gen(function*() {
      const { clientLog } = yield* harness
      const store = yield* sharedStore
      const kv = Context.get(yield* Layer.build(store), KeyValueStore.KeyValueStore)
      yield* kv.set(Counter.name, JSON.stringify({ count: 2 }))

      const error = yield* Effect.flip(persistedOn(clientLog, store))

      assert.strictEqual(error._tag, "SchemaError")
      assert.strictEqual(yield* storedText(store), "{\"count\":2}")
    }))

  it.effect("logs a checkpoint the store refused and keeps applying entries", () =>
    Effect.gen(function*() {
      const logs = captureLogs()
      const { clientLog } = yield* harness
      const refusing = Layer.effect(
        KeyValueStore.KeyValueStore,
        Effect.gen(function*() {
          const inner = yield* KeyValueStore.KeyValueStore
          const set: KeyValueStore.KeyValueStore["set"] = (key) =>
            Effect.fail(new KeyValueStore.KeyValueStoreError({ method: "set", key, message: "disk full" }))
          return { ...inner, set }
        })
      ).pipe(Layer.provide(Layer.fresh(KeyValueStore.layerMemory)))
      const { instance } = yield* persistedOn(clientLog, refusing).pipe(Effect.provide(logs.layer))

      yield* instance.model.present(inc(2))
      yield* settle

      assert.deepStrictEqual(yield* countsOf(instance), [0, 2])
      assert.include(logs.entries.map((entry) => entry.message).flat(), "checkpoint not persisted")
    }))
})
