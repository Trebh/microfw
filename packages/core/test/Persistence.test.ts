import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, Fiber, Layer, Option, Ref, Scope, Stream } from "effect"
import { KeyValueStore } from "effect/persistence"
import { TestClock } from "effect/testing"
import { AutoActions, layerLoopPersisted } from "../src/index.ts"
import { Counter, Ports } from "./fixtures/Counter.ts"
import { captureLogs, settle } from "./support.ts"

const NoAutoActions = Layer.succeed(AutoActions, false)

/** An in-memory store that already holds `text` under the Counter's key. */
const storeHolding = (text: string) =>
  Layer.effect(
    KeyValueStore.KeyValueStore,
    Effect.gen(function*() {
      const store = yield* KeyValueStore.KeyValueStore
      yield* store.set(Counter.name, text)
      return store
    })
  ).pipe(Layer.provide(KeyValueStore.layerMemory))

/** An in-memory store whose first `set` fails, as a disk that is full for one write. */
const storeFailingFirstWrite = Layer.effect(
  KeyValueStore.KeyValueStore,
  Effect.gen(function*() {
    const inner = yield* KeyValueStore.KeyValueStore
    const failuresLeft = yield* Ref.make(1)
    const fail = (key: string) => new KeyValueStore.KeyValueStoreError({ method: "set", key, message: "disk full" })
    const set: KeyValueStore.KeyValueStore["set"] = (key, value) =>
      Effect.flatMap(
        Ref.getAndUpdate(failuresLeft, (left) => Math.max(0, left - 1)),
        (left) => left > 0 ? Effect.fail(fail(key)) : inner.set(key, value)
      )
    return { ...inner, set }
  })
).pipe(Layer.provide(KeyValueStore.layerMemory))

/** An in-memory store whose `set` takes 10 seconds: `started` receives each text when its write begins. */
const slowStore = (started: Array<string>) =>
  Layer.effect(
    KeyValueStore.KeyValueStore,
    Effect.gen(function*() {
      const inner = yield* KeyValueStore.KeyValueStore
      const set: KeyValueStore.KeyValueStore["set"] = (key, value) =>
        Effect.sync(() => started.push(String(value))).pipe(
          Effect.andThen(Effect.sleep("10 seconds")),
          Effect.andThen(inner.set(key, value))
        )
      return KeyValueStore.make({ ...inner, set })
    })
  ).pipe(Layer.provide(KeyValueStore.layerMemory))

/** The persisted Counter loop over `store`; the store stays in the context for the test to read. */
const persistedLoop = <E>(store: Layer.Layer<KeyValueStore.KeyValueStore, E>) =>
  layerLoopPersisted(Counter, Ports).pipe(Layer.provideMerge(store), Layer.provide(NoAutoActions))

const inc = (by: number) => ({ _tag: "Inc", by }) as const

describe("layerLoopPersisted", () => {
  it.effect("starts from the stored model", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort

      const current = yield* Stream.runHead(model.representations)

      assert.deepStrictEqual(current, Option.some({ controlState: "high", count: 5 }))
    }).pipe(Effect.provide(persistedLoop(storeHolding("{\"count\":5}")))))

  it.effect("starts from def.initial when nothing is stored", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort

      const current = yield* Stream.runHead(model.representations)

      assert.deepStrictEqual(current, Option.some({ controlState: "low", count: 0 }))
    }).pipe(Effect.provide(persistedLoop(KeyValueStore.layerMemory))))

  it.effect("writes nothing until the first step", () =>
    Effect.gen(function*() {
      const store = yield* KeyValueStore.KeyValueStore
      yield* settle

      const stored = yield* store.get(Counter.name)

      assert.strictEqual(stored, undefined)
    }).pipe(Effect.provide(persistedLoop(KeyValueStore.layerMemory))))

  it.effect("writes the model of a step as JSON under the definition's name", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const store = yield* KeyValueStore.KeyValueStore

      yield* model.present(inc(2))
      yield* settle

      assert.strictEqual(yield* store.get(Counter.name), "{\"count\":2}")
    }).pipe(Effect.provide(persistedLoop(KeyValueStore.layerMemory))))

  it.effect("writes the model a travel restores", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      const store = yield* KeyValueStore.KeyValueStore
      yield* model.present(inc(1))
      yield* model.present(inc(2))
      yield* settle

      yield* history.travelTo(1)
      yield* settle

      assert.strictEqual(yield* store.get(Counter.name), "{\"count\":1}")
    }).pipe(Effect.provide(persistedLoop(KeyValueStore.layerMemory))))

  it.effect("a loop built later over the same store continues from the last step", () =>
    Effect.gen(function*() {
      const store = yield* Layer.build(KeyValueStore.layerMemory)
      const sharedStore = Layer.succeedContext(store)
      const first = yield* Layer.build(persistedLoop(sharedStore))
      yield* Context.get(first, Ports.ModelPort).present(inc(2))
      yield* settle

      const second = yield* Layer.build(persistedLoop(sharedStore))
      const current = yield* Stream.runHead(Context.get(second, Ports.ModelPort).representations)

      assert.deepStrictEqual(current, Option.some({ controlState: "low", count: 2 }))
    }))

  it.effect("fails the layer with a SchemaError when the stored model does not decode", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(Layer.build(persistedLoop(storeHolding("{\"count\":\"many\"}"))))

      assert.strictEqual(error._tag, "SchemaError")
    }))

  it.effect("fails the layer with a SchemaError when the stored text is not JSON", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(Layer.build(persistedLoop(storeHolding("{\"count\":"))))

      assert.strictEqual(error._tag, "SchemaError")
    }))

  it.effect("leaves a stored value that does not decode untouched", () =>
    Effect.gen(function*() {
      const store = yield* Layer.build(storeHolding("{\"count\":\"many\"}"))
      yield* Effect.flip(Layer.build(persistedLoop(Layer.succeedContext(store))))

      const stored = yield* Context.get(store, KeyValueStore.KeyValueStore).get(Counter.name)

      assert.strictEqual(stored, "{\"count\":\"many\"}")
    }))

  it.effect("logs a failed write at error level and writes the next step", () => {
    const logs = captureLogs()
    return Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const store = yield* KeyValueStore.KeyValueStore

      yield* model.present(inc(1))
      yield* settle
      yield* model.present(inc(2))
      yield* settle

      assert.strictEqual(yield* store.get(Counter.name), "{\"count\":3}")
      assert.deepStrictEqual(logs.entries.map((entry) => [entry.level, entry.message]), [
        ["Error", ["model not persisted", 1]]
      ])
      assert.include(logs.entries[0]?.cause, "disk full")
    }).pipe(Effect.provide(persistedLoop(storeFailingFirstWrite).pipe(Layer.provide(logs.layer))))
  })

  it.effect("a write in flight when the scope closes completes", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(persistedLoop(slowStore([])), scope)
      yield* Context.get(context, Ports.ModelPort).present(inc(2))
      yield* settle

      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
      yield* settle
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(closing)

      assert.strictEqual(yield* Context.get(context, KeyValueStore.KeyValueStore).get(Counter.name), "{\"count\":2}")
    }))

  it.effect("writes only the first and the newest model while a slow store is busy", () =>
    Effect.gen(function*() {
      const writes: Array<string> = []
      const context = yield* Layer.build(persistedLoop(slowStore(writes)))
      const model = Context.get(context, Ports.ModelPort)
      yield* model.present(inc(1))
      yield* settle

      yield* model.present(inc(2))
      yield* model.present(inc(3))
      yield* model.present(inc(4))
      yield* settle
      yield* TestClock.adjust("10 seconds")
      yield* settle
      yield* TestClock.adjust("10 seconds")
      yield* settle

      assert.deepStrictEqual(writes, ["{\"count\":1}", "{\"count\":10}"])
    }))
})
