import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Ref, Schema, Scope } from "effect"
import { SchemaBinary } from "effect/encoding"
import { Event, EventJournal } from "effect/eventlog"
import { KeyValueStore } from "effect/persistence"
import { type CutRequest, layerSyncStorage, noLease, SyncLog, SyncStorageCut } from "../src/SyncEntry.ts"
import { Counter } from "./fixtures/Counter.ts"
import {
  bootOver as boot,
  countsOf,
  currentRepresentation,
  harnessOver,
  instanceOn,
  joinedEntry,
  losingNewestSegment,
  readLog,
  sharedStore
} from "./fixtures/SyncHarness.ts"

const inc = (by: number) => ({ _tag: "Inc", by }) as const

/** `boot` that also hands out the storage's own `SyncStorageCut`, which the harness does not. */
const bootCutting = <E, R>(store: Layer.Layer<KeyValueStore.KeyValueStore, E, R>) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const built = yield* Layer.build(layerSyncStorage(Counter).pipe(Layer.provide(store))).pipe(Scope.provide(scope))
    const host = yield* harnessOver(Layer.succeedContext(built)).pipe(Scope.provide(scope))
    return { ...host, logCut: Context.get(built, SyncStorageCut), stop: Scope.close(scope, Exit.void) }
  })

const cutRequest = (through: number, retain: number): CutRequest => ({
  through,
  model: { count: 7 },
  lease: noLease,
  retain
})

/** `count` entries appended through the host's own log, with sequences `1..count`. */
const appendJoined = <E, R>(hostLog: Layer.Layer<SyncLog, E, R>, count: number) =>
  Effect.gen(function*() {
    const log = Context.get(yield* Layer.build(hostLog), SyncLog)
    const entries = Array.from({ length: count }, (_, index) => joinedEntry(index))
    yield* Effect.forEach(entries, log.append, { discard: true })
    return log
  })

const eventsOf = (entries: ReadonlyArray<EventJournal.RemoteEntry>) =>
  entries.map((remote) => [remote.remoteSequence, remote.entry.event])

const sequencesOf = (entries: ReadonlyArray<EventJournal.RemoteEntry>) => entries.map((remote) => remote.remoteSequence)

/** A store that fails to point `start` anywhere and to remove any key: what a cut that stopped early leaves behind. */
const failingToRetire = <E, R>(inner: Layer.Layer<KeyValueStore.KeyValueStore, E, R>) =>
  Layer.effect(
    KeyValueStore.KeyValueStore,
    Effect.gen(function*() {
      const kv = yield* KeyValueStore.KeyValueStore
      const refusal = (method: string, key: string) =>
        Effect.fail(new KeyValueStore.KeyValueStoreError({ method, key, message: "disk full" }))
      const set: KeyValueStore.KeyValueStore["set"] = (key, value) =>
        key.endsWith("/start") ? refusal("set", key) : kv.set(key, value)
      const remove: KeyValueStore.KeyValueStore["remove"] = (key) => refusal("remove", key)
      return { ...kv, set, remove }
    })
  ).pipe(Layer.provide(inner))

/** A store that counts the writes made through it. */
const countingWrites = <E, R>(inner: Layer.Layer<KeyValueStore.KeyValueStore, E, R>, writes: Ref.Ref<number>) =>
  Layer.effect(
    KeyValueStore.KeyValueStore,
    Effect.gen(function*() {
      const kv = yield* KeyValueStore.KeyValueStore
      const counted = Ref.update(writes, (count) => count + 1)
      const set: KeyValueStore.KeyValueStore["set"] = (key, value) => counted.pipe(Effect.andThen(kv.set(key, value)))
      const remove: KeyValueStore.KeyValueStore["remove"] = (key) => counted.pipe(Effect.andThen(kv.remove(key)))
      return { ...kv, set, remove }
    })
  ).pipe(Layer.provide(inner))

const joinedEvent = Event.make({ tag: "Joined", primaryKey: () => Counter.name })
const encodeJoined = Schema.encodeUnknownEffect(joinedEvent.payloadSchemaBinary)

/** A `Joined` entry whose payload the server decodes, which a client may write (`joinedEntry`'s empty one does not decode). */
const writableJoined = (millis: number) =>
  Effect.gen(function*() {
    const payload = yield* encodeJoined(undefined)
    const id = EventJournal.makeEntryIdUnsafe({ msecs: millis })
    return new EventJournal.Entry({ id, event: "Joined", primaryKey: Counter.name, payload: payload.slice() })
  })

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

  it.effect("reports the stored log's last sequence after the host is rebuilt", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const first = yield* boot(store)
      const a = yield* instanceOn(first.hostLog, false)
      yield* a.model.present(inc(2))
      yield* a.model.present(inc(3))
      yield* first.stop
      const second = yield* boot(store)

      const onHost = yield* readLog(second.hostLog, 0)
      const onClient = yield* readLog(second.clientLog, 0)

      assert.strictEqual(onHost.last, 3)
      assert.strictEqual(onClient.last, 3)
    }))

  it.effect("reports 256 as the last sequence after the newest segment of a 300-entry log was lost", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const first = yield* boot(store)
      const log = Context.get(yield* Layer.build(first.hostLog), SyncLog)
      yield* Effect.forEach(Array.from({ length: 300 }, (_, index) => joinedEntry(index)), log.append, { discard: true })
      const before = yield* readLog(first.hostLog, 300)
      yield* first.stop
      yield* losingNewestSegment(store)
      const second = yield* boot(store)

      const after = yield* readLog(second.hostLog, 0)

      assert.strictEqual(after.entries.length, 256)
      assert.strictEqual(after.last, 256)
      assert.strictEqual(after.log, before.log)
    }))
})

describe("layerSyncStorage cut", () => {
  it.effect("keeps the snapshot and the later entries at their sequences across a rebuild", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const first = yield* bootCutting(store)
      yield* appendJoined(first.hostLog, 600)
      yield* first.logCut.cut(cutRequest(300, 8))
      yield* first.stop

      const second = yield* bootCutting(store)
      const { entries } = yield* readLog(second.hostLog, 0)

      assert.deepStrictEqual(eventsOf(entries.slice(0, 2)), [[300, "Snapshot"], [301, "Joined"]])
      assert.deepStrictEqual(sequencesOf(entries), Array.from({ length: 301 }, (_, index) => 300 + index))
    }))

  it.effect("appends after a cut log's newest sequence once it is rebuilt", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const first = yield* bootCutting(store)
      yield* appendJoined(first.hostLog, 600)
      yield* first.logCut.cut(cutRequest(300, 8))
      yield* first.stop
      const second = yield* bootCutting(store)
      const log = Context.get(yield* Layer.build(second.hostLog), SyncLog)

      yield* log.append(joinedEntry(600))
      const { entries } = yield* readLog(second.hostLog, 600)

      assert.deepStrictEqual(eventsOf(entries), [[600, "Joined"], [601, "Joined"]])
    }))

  it.effect("reports the sequence of the newest entry as the head of a cut log", () =>
    Effect.gen(function*() {
      const host = yield* bootCutting(yield* sharedStore)
      yield* appendJoined(host.hostLog, 600)
      yield* host.logCut.cut(cutRequest(300, 8))

      const { last } = yield* readLog(host.hostLog, 0)

      assert.strictEqual(last, 600)
    }))

  it.effect("removes the stored segments before the snapshot's", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const kv = Context.get(yield* Layer.build(store), KeyValueStore.KeyValueStore)
      const host = yield* bootCutting(store)
      yield* appendJoined(host.hostLog, 600)

      yield* host.logCut.cut(cutRequest(520, 8))

      assert.isFalse(yield* kv.has(`${Counter.name}/log/0`))
      assert.isFalse(yield* kv.has(`${Counter.name}/log/1`))
      assert.isTrue(yield* kv.has(`${Counter.name}/log/2`))
      assert.strictEqual(yield* kv.get(`${Counter.name}/log/start`), "2")
    }))

  it.effect("reads a log whose cut stopped after the snapshot's segment was written", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const first = yield* bootCutting(failingToRetire(store))
      yield* appendJoined(first.hostLog, 600)
      yield* first.logCut.cut(cutRequest(300, 8))
      yield* first.stop

      const second = yield* bootCutting(store)
      const { entries } = yield* readLog(second.hostLog, 0)

      assert.deepStrictEqual(eventsOf(entries.slice(0, 2)), [[300, "Snapshot"], [301, "Joined"]])
      assert.deepStrictEqual(sequencesOf(entries), Array.from({ length: 301 }, (_, index) => 300 + index))
    }))

  it.effect("removes the segments a stopped cut left behind when the log is rebuilt", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const kv = Context.get(yield* Layer.build(store), KeyValueStore.KeyValueStore)
      const first = yield* bootCutting(failingToRetire(store))
      yield* appendJoined(first.hostLog, 600)
      yield* first.logCut.cut(cutRequest(300, 8))
      yield* first.stop

      yield* bootCutting(store)

      assert.isFalse(yield* kv.has(`${Counter.name}/log/0`))
      assert.strictEqual(yield* kv.get(`${Counter.name}/log/start`), "1")
    }))

  it.effect("reads a log stored before cuts existed without writing to the store", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const kv = Context.get(yield* Layer.build(store), KeyValueStore.KeyValueStore)
      const encode = Schema.encodeEffect(SchemaBinary.toCodec(Schema.Array(EventJournal.Entry)))
      const entries = Array.from({ length: 300 }, (_, index) => joinedEntry(index))
      yield* kv.set(`${Counter.name}/log/id`, EventJournal.makeRemoteIdUnsafe())
      yield* kv.set(`${Counter.name}/log/0`, yield* encode(entries.slice(0, 256)))
      yield* kv.set(`${Counter.name}/log/1`, yield* encode(entries.slice(256)))
      const writes = yield* Ref.make(0)

      const host = yield* bootCutting(countingWrites(store, writes))
      const { entries: loaded } = yield* readLog(host.hostLog, 0)

      assert.deepStrictEqual(sequencesOf(loaded), Array.from({ length: 300 }, (_, index) => index + 1))
      assert.deepStrictEqual(loaded.map((remote) => remote.entry.idString), entries.map((entry) => entry.idString))
      assert.strictEqual(yield* Ref.get(writes), 0)
    }))

  it.effect("reports the sequence of its snapshot as the base, and ignores a cut at or before it", () =>
    Effect.gen(function*() {
      const host = yield* bootCutting(yield* sharedStore)
      yield* appendJoined(host.hostLog, 600)
      yield* host.logCut.cut(cutRequest(300, 8))
      const before = yield* readLog(host.hostLog, 0)

      yield* host.logCut.cut(cutRequest(200, 8))
      yield* host.logCut.cut(cutRequest(300, 8))
      const after = yield* readLog(host.hostLog, 0)

      assert.strictEqual(yield* host.logCut.base, 300)
      assert.deepStrictEqual(
        after.entries.map((remote) => remote.entry.idString),
        before.entries.map((remote) => remote.entry.idString)
      )
    }))

  it.effect("reports 0 as the base of a log that was never cut", () =>
    Effect.gen(function*() {
      const host = yield* bootCutting(yield* sharedStore)
      yield* appendJoined(host.hostLog, 3)

      assert.strictEqual(yield* host.logCut.base, 0)
    }))

  it.effect("dies on a cut past the log's newest entry", () =>
    Effect.gen(function*() {
      const host = yield* bootCutting(yield* sharedStore)
      yield* appendJoined(host.hostLog, 3)

      const exit = yield* Effect.exit(host.logCut.cut(cutRequest(4, 8)))

      assert.isTrue(Exit.hasDies(exit))
    }))

  it.effect("refuses a Snapshot written through write", () =>
    Effect.gen(function*() {
      const host = yield* bootCutting(yield* sharedStore)
      const log = yield* appendJoined(host.hostLog, 1)
      const snapshot = new EventJournal.Entry({
        id: EventJournal.makeEntryIdUnsafe({ msecs: 5 }),
        event: "Snapshot",
        primaryKey: Counter.name,
        payload: new Uint8Array()
      }, { disableChecks: true })

      const exit = yield* Effect.exit(log.append(snapshot))
      const { entries } = yield* readLog(host.hostLog, 0)

      assert.isTrue(Exit.hasDies(exit))
      assert.deepStrictEqual(eventsOf(entries), [[1, "Joined"]])
    }))

  it.effect("drops a copy of an entry whose first copy was cut away, from a client", () =>
    Effect.gen(function*() {
      const host = yield* bootCutting(yield* sharedStore)
      const client = Context.get(yield* Layer.build(host.clientLog), SyncLog)
      const entry = yield* writableJoined(1)
      yield* client.append(entry)
      yield* host.logCut.cut(cutRequest(1, 8))

      yield* client.append(entry)
      const { entries } = yield* readLog(host.hostLog, 0)

      assert.deepStrictEqual(eventsOf(entries), [[1, "Snapshot"]])
    }))

  it.effect("stores a copy of a cut entry again when the snapshot kept no ids", () =>
    Effect.gen(function*() {
      const host = yield* bootCutting(yield* sharedStore)
      const client = Context.get(yield* Layer.build(host.clientLog), SyncLog)
      const entry = yield* writableJoined(1)
      yield* client.append(entry)
      yield* host.logCut.cut(cutRequest(1, 0))

      yield* client.append(entry)
      const { entries } = yield* readLog(host.hostLog, 0)

      assert.deepStrictEqual(eventsOf(entries), [[1, "Snapshot"], [2, "Joined"]])
    }))

  it.effect("refuses an in-process write of an entry whose first copy was cut away", () =>
    Effect.gen(function*() {
      const host = yield* bootCutting(yield* sharedStore)
      const log = Context.get(yield* Layer.build(host.hostLog), SyncLog)
      const entry = joinedEntry(1)
      yield* log.append(entry)
      yield* host.logCut.cut(cutRequest(1, 8))

      const exit = yield* Effect.exit(log.append(entry))

      assert.isTrue(Exit.hasDies(exit))
    }))

  it.effect("keeps the ids a snapshot stood for when a later cut replaces it", () =>
    Effect.gen(function*() {
      const host = yield* bootCutting(yield* sharedStore)
      const client = Context.get(yield* Layer.build(host.clientLog), SyncLog)
      const entry = yield* writableJoined(1)
      yield* client.append(entry)
      yield* host.logCut.cut(cutRequest(1, 8))
      yield* client.append(yield* writableJoined(2))
      yield* host.logCut.cut(cutRequest(2, 8))

      yield* client.append(entry)
      const { entries } = yield* readLog(host.hostLog, 0)

      assert.deepStrictEqual(eventsOf(entries), [[2, "Snapshot"]])
    }))

  it.effect("keeps the ids a snapshot stood for across a rebuild", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const first = yield* bootCutting(store)
      const client = Context.get(yield* Layer.build(first.clientLog), SyncLog)
      const entry = yield* writableJoined(1)
      yield* client.append(entry)
      yield* first.logCut.cut(cutRequest(1, 8))
      yield* first.stop
      const second = yield* bootCutting(store)
      const rebuilt = Context.get(yield* Layer.build(second.clientLog), SyncLog)

      yield* rebuilt.append(entry)
      const { entries } = yield* readLog(second.hostLog, 0)

      assert.deepStrictEqual(eventsOf(entries), [[1, "Snapshot"]])
    }))
})
