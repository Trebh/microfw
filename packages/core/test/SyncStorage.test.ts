import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { EventJournal } from "effect/eventlog"
import { KeyValueStore } from "effect/persistence"
import { layerSyncStorage, SyncLog } from "../src/SyncEntry.ts"
import { Counter } from "./fixtures/Counter.ts"
import { countsOf, currentRepresentation, harnessOver, instanceOn, readLog, sharedStore } from "./fixtures/SyncHarness.ts"

const inc = (by: number) => ({ _tag: "Inc", by }) as const

/** One boot of a host over `store`: its own scope, which closing ends the host, the store staying. */
const boot = <E, R>(store: Layer.Layer<KeyValueStore.KeyValueStore, E, R>) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const host = yield* harnessOver(layerSyncStorage(Counter).pipe(Layer.provide(store))).pipe(Scope.provide(scope))
    return { ...host, stop: Scope.close(scope, Exit.void) }
  })

const joinedEntry = (millis: number) =>
  new EventJournal.Entry({
    id: EventJournal.makeEntryIdUnsafe({ msecs: millis }),
    event: "Joined",
    primaryKey: Counter.name,
    payload: new Uint8Array()
  }, { disableChecks: true })

describe("layerSyncStorage", () => {
  it.effect("serves the same entries with the same sequences after the host is rebuilt", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const first = yield* boot(store)
      const a = yield* instanceOn(first.hostLog, false)
      yield* a.model.present(inc(2))
      yield* a.model.present(inc(3))
      const before = yield* readLog(first.hostLog, 0)
      yield* first.stop

      const second = yield* boot(store)
      const after = yield* readLog(second.hostLog, 0)

      assert.deepStrictEqual(
        after.entries.map((remote) => [remote.remoteSequence, remote.entry.event, remote.entry.idString]),
        before.entries.map((remote) => [remote.remoteSequence, remote.entry.event, remote.entry.idString])
      )
      assert.deepStrictEqual(after.entries.map((remote) => [remote.remoteSequence, remote.entry.event]), [
        [1, "Joined"],
        [2, "Proposal"],
        [3, "Proposal"]
      ])
    }))

  it.effect("keeps the log's id across a rebuild, and gives another log another id", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const first = yield* boot(store)
      const before = yield* readLog(first.hostLog, 0)
      yield* first.stop
      const second = yield* boot(store)
      const unrelated = yield* boot(yield* sharedStore)

      const after = yield* readLog(second.hostLog, 0)
      const other = yield* readLog(unrelated.hostLog, 0)

      assert.strictEqual(after.log, before.log)
      assert.notStrictEqual(other.log, before.log)
    }))

  it.effect("continues the sequence where the stopped host left it", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const first = yield* boot(store)
      const a = yield* instanceOn(first.hostLog, false)
      yield* a.model.present(inc(1))
      yield* first.stop
      const second = yield* boot(store)

      const b = yield* instanceOn(second.hostLog, false)
      yield* b.model.present(inc(1))
      const entries = (yield* readLog(second.hostLog, 0)).entries

      assert.deepStrictEqual(entries.map((remote) => [remote.remoteSequence, remote.entry.event]), [
        [1, "Joined"],
        [2, "Proposal"],
        [3, "Joined"],
        [4, "Proposal"]
      ])
    }))

  it.effect("serves a joiner that connects after the host's restart the model of the whole log", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const first = yield* boot(store)
      const a = yield* instanceOn(first.hostLog, false)
      yield* a.model.present(inc(2))
      yield* first.stop
      const second = yield* boot(store)

      const joiner = yield* instanceOn(second.clientLog, false)

      assert.deepStrictEqual(yield* currentRepresentation(joiner), { controlState: "low", count: 2 })
      assert.deepStrictEqual(yield* countsOf(joiner), [0, 2])
    }))

  it.effect("holds more entries than one stored segment, in order, across a rebuild", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const first = yield* boot(store)
      const log = Context.get(yield* Layer.build(first.hostLog), SyncLog)
      yield* Effect.forEach(Array.from({ length: 300 }, (_, index) => joinedEntry(index)), log.append, { discard: true })
      yield* first.stop

      const second = yield* boot(store)
      const { entries } = yield* readLog(second.hostLog, 0)

      assert.strictEqual(entries.length, 300)
      assert.deepStrictEqual(entries.map((remote) => remote.remoteSequence).slice(254, 258), [255, 256, 257, 258])
      assert.strictEqual(entries[299]?.remoteSequence, 300)
    }))

  it.effect("delivers a joiner that resumes in the middle of the log only the later entries", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const host = yield* boot(store)
      const a = yield* instanceOn(host.hostLog, false)
      yield* a.model.present(inc(1))
      yield* a.model.present(inc(1))

      const { entries } = yield* readLog(host.hostLog, 3)

      assert.deepStrictEqual(entries.map((remote) => remote.remoteSequence), [3])
    }))

  it.effect("does not deliver an entry that the key-value store refused", () =>
    Effect.gen(function*() {
      const refusing = Layer.effect(
        KeyValueStore.KeyValueStore,
        Effect.gen(function*() {
          const inner = yield* KeyValueStore.KeyValueStore
          const set: KeyValueStore.KeyValueStore["set"] = (key, value) =>
            key.endsWith("/0")
              ? Effect.fail(new KeyValueStore.KeyValueStoreError({ method: "set", key, message: "disk full" }))
              : inner.set(key, value)
          return { ...inner, set }
        })
      ).pipe(Layer.provide(KeyValueStore.layerMemory))
      const host = yield* boot(refusing)
      const log = Context.get(yield* Layer.build(host.hostLog), SyncLog)

      const exit = yield* Effect.exit(log.append(joinedEntry(0)))
      const { entries } = yield* readLog(host.hostLog, 0)

      assert.isTrue(Exit.isFailure(exit))
      assert.deepStrictEqual(entries, [])
    }))

  it.effect("fails to build over a stored segment that does not decode", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const kv = Context.get(yield* Layer.build(store), KeyValueStore.KeyValueStore)
      yield* kv.set(`${Counter.name}/log/0`, Uint8Array.of(255, 255, 255))

      const error = yield* Effect.flip(boot(store))

      assert.strictEqual(error._tag, "SchemaError")
    }))

  it.effect("fails to build over a stored id that is not an id", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const kv = Context.get(yield* Layer.build(store), KeyValueStore.KeyValueStore)
      yield* kv.set(`${Counter.name}/log/id`, Uint8Array.of(1, 2, 3))

      const error = yield* Effect.flip(boot(store))

      assert.strictEqual(error._tag, "SchemaError")
    }))
})
