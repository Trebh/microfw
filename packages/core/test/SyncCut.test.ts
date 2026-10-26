import { assert, describe, it } from "@effect/vitest"
import { Context, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { SchemaBinary } from "effect/encoding"
import { EventJournal } from "effect/eventlog"
import { TestClock } from "effect/testing"
import { Lease, noLease, SNAPSHOT, SyncLog, type SyncStop, SyncSnapshotUnreadable } from "../src/SyncEntry.ts"
import { Counter } from "./fixtures/Counter.ts"
import { snapshotPayloadThrough } from "./fixtures/SnapshotEntries.ts"
import {
  bootOver,
  countsOf,
  cuttingHarness,
  currentRepresentation,
  harness,
  instanceOn,
  kindsOf,
  loopOn,
  readLog,
  sharedStore,
  stoppableOn
} from "./fixtures/SyncHarness.ts"
import { cutOff, droppedOnFirstProposal, linkedBy, type Link, lostAfter, openLink } from "./fixtures/SyncLinks.ts"
import { settle } from "./support.ts"

const inc = (by: number) => ({ _tag: "Inc", by }) as const

/** The sequence and the event of each entry. */
const eventsOf = (entries: ReadonlyArray<EventJournal.RemoteEntry>) =>
  entries.map((remote) => [remote.remoteSequence, remote.entry.event])

const encodeProposal = Schema.encodeUnknownEffect(SchemaBinary.toCodec(Counter.proposal))
const decodeLease = Schema.decodeUnknownEffect(SchemaBinary.toCodec(Lease))

/** A `Proposal` entry for an increment, as an instance writes it. */
const proposalEntry = (by: number) =>
  Effect.map(encodeProposal(inc(by)), (payload) =>
    new EventJournal.Entry({
      id: EventJournal.makeEntryIdUnsafe({ msecs: 1 }),
      event: "Proposal",
      primaryKey: Counter.name,
      payload
    }, { disableChecks: true }))

/**
 * A host that cut its log at sequence 3 (its `Joined`, then two increments of 1), then applied an
 * increment of 2 at sequence 4, and what the log held before any other instance joined.
 */
const logCutAtThree = Effect.gen(function*() {
  const { hostLog, clientLog } = yield* cuttingHarness
  const host = yield* instanceOn(hostLog, false, { cut: { every: 3 } })
  yield* host.model.present(inc(1))
  yield* host.model.present(inc(1))
  yield* settle
  yield* host.model.present(inc(2))
  const { log, entries } = yield* readLog(hostLog, 0)
  return { hostLog, clientLog, log, events: eventsOf(entries) }
})

/** Wraps a log so that the first entry it delivers is a `Snapshot` with `payload`, whatever it was. */
const snapshotInsteadOfFirstEntry = <E, R>(log: Layer.Layer<SyncLog, E, R>, payload: Uint8Array) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const inner = yield* SyncLog
      let delivered = 0
      const asSnapshot = (remote: EventJournal.RemoteEntry) =>
        new EventJournal.RemoteEntry({
          remoteSequence: remote.remoteSequence,
          entry: new EventJournal.Entry({
            id: remote.entry.id,
            event: SNAPSHOT,
            primaryKey: remote.entry.primaryKey,
            payload
          }, { disableChecks: true })
        }, { disableChecks: true })
      const rewritten = (remote: EventJournal.RemoteEntry) => {
        delivered += 1
        return delivered === 1 ? asSnapshot(remote) : remote
      }
      const follow = (from: number) =>
        Effect.map(inner.follow(from), (subscription) => ({
          ...subscription,
          entries: Stream.map(subscription.entries, rewritten)
        }))
      return SyncLog.of({ ...inner, follow })
    })
  ).pipe(Layer.provide(log))

/** Wraps a log so that it subscribes only while `link` delivers: a reconnection that waits for the network. */
const subscribingWhileDelivering = <E, R>(log: Layer.Layer<SyncLog, E, R>, link: Link) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const inner = yield* SyncLog
      return SyncLog.of({ ...inner, follow: (from) => link.deliver.await.pipe(Effect.andThen(inner.follow(from))) })
    })
  ).pipe(Layer.provide(log))

describe("a log cut by a snapshot", () => {
  it.effect("serves a joiner that starts from the snapshot the model of the whole log", () =>
    Effect.gen(function*() {
      const { clientLog, events } = yield* logCutAtThree

      const joiner = yield* instanceOn(clientLog, false)

      assert.deepStrictEqual(events, [[3, "Snapshot"], [4, "Proposal"]])
      assert.deepStrictEqual(yield* currentRepresentation(joiner), { controlState: "high", count: 4 })
      assert.deepStrictEqual(yield* countsOf(joiner), [0, 2, 4])
      assert.deepStrictEqual(yield* kindsOf(joiner), ["init", "restore", "step"])
    }))

  it.effect("holds the log near `every` entries however many arrive", () =>
    Effect.gen(function*() {
      const { hostLog } = yield* cuttingHarness
      const host = yield* instanceOn(hostLog, false, { cut: { every: 3 } })

      yield* Effect.forEach(
        Array.from({ length: 10 }),
        () => host.model.present(inc(1)).pipe(Effect.andThen(settle)),
        { discard: true }
      )
      const { entries } = yield* readLog(hostLog, 0)

      assert.deepStrictEqual(eventsOf(entries), [[9, "Snapshot"], [10, "Proposal"], [11, "Proposal"]])
    }))

  it.effect("gives an instance whose checkpoint is before the cut the snapshot, then the later entries", () =>
    Effect.gen(function*() {
      const { clientLog, log } = yield* logCutAtThree

      const resumed = yield* instanceOn(clientLog, false, {
        resume: { log, sequence: 2, model: { count: 1 }, lease: noLease }
      })

      assert.deepStrictEqual(yield* countsOf(resumed), [1, 2, 4])
      assert.deepStrictEqual(yield* kindsOf(resumed), ["init", "restore", "step"])
    }))

  it.effect("never delivers the snapshot to an instance whose checkpoint is at or after the cut", () =>
    Effect.gen(function*() {
      const { clientLog, log } = yield* logCutAtThree

      const resumed = yield* instanceOn(clientLog, false, {
        resume: { log, sequence: 3, model: { count: 2 }, lease: noLease }
      })

      assert.deepStrictEqual(yield* countsOf(resumed), [2, 4])
      assert.deepStrictEqual(yield* kindsOf(resumed), ["init", "step"])
    }))

  it.effect("counts the entries since the last cut from the log, not from the process", () =>
    Effect.gen(function*() {
      const store = yield* sharedStore
      const first = yield* bootOver(store)
      const firstHost = yield* stoppableOn(first.hostLog, false, { cut: { every: 4 } })
      yield* Effect.forEach(Array.from({ length: 5 }), () => firstHost.instance.model.present(inc(1)), {
        discard: true
      })
      yield* settle
      const { log } = yield* readLog(first.hostLog, 0)
      yield* firstHost.stop
      yield* first.stop

      const second = yield* bootOver(store)
      const secondHost = yield* instanceOn(second.hostLog, false, {
        cut: { every: 4 },
        resume: { log, sequence: 6, model: { count: 5 }, lease: noLease }
      })
      yield* secondHost.model.present(inc(1))
      yield* settle
      const { entries } = yield* readLog(second.hostLog, 0)

      assert.deepStrictEqual(eventsOf(entries), [[8, "Snapshot"]])
    }))
})

describe("a cut that the log cannot make", () => {
  it.effect("fails the layer of a host over a memory storage with SyncCutUnsupported, before it writes", () =>
    Effect.gen(function*() {
      const { hostLog } = yield* harness

      const error = yield* Effect.flip(Layer.build(loopOn(hostLog, false, { cut: { every: 3 } })))
      const stored = yield* readLog(hostLog, 0)

      assert.strictEqual(error._tag, "SyncCutUnsupported")
      assert.strictEqual(stored.last, 0)
    }))

  it.effect("fails the layer of a joiner with SyncCutUnsupported, before it writes", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness

      const error = yield* Effect.flip(Layer.build(loopOn(clientLog, false, { cut: { every: 3 } })))
      const stored = yield* readLog(hostLog, 0)

      assert.strictEqual(error._tag, "SyncCutUnsupported")
      assert.strictEqual(stored.last, 0)
    }))
})

describe("a snapshot the instance cannot read", () => {
  it.effect("fails the layer with SyncSnapshotUnreadable when the snapshot does not decode", () =>
    Effect.gen(function*() {
      const { hostLog } = yield* harness
      const stopped = yield* Deferred.make<never, SyncStop>()
      const unreadable = snapshotInsteadOfFirstEntry(hostLog, Uint8Array.of(255, 255, 255))

      const error = yield* Effect.flip(Layer.build(loopOn(unreadable, false, { stopped })))
      const stop = yield* Effect.flip(Deferred.await(stopped))

      assert.instanceOf(error, SyncSnapshotUnreadable)
      assert.strictEqual(error.sequence, 1)
      assert.strictEqual(stop, error)
    }))

  it.effect("fails the layer with SyncSnapshotUnreadable when the snapshot says it stands for another sequence", () =>
    Effect.gen(function*() {
      const { hostLog } = yield* harness
      const stopped = yield* Deferred.make<never, SyncStop>()
      const unreadable = snapshotInsteadOfFirstEntry(hostLog, yield* snapshotPayloadThrough(2))

      const error = yield* Effect.flip(Layer.build(loopOn(unreadable, false, { stopped })))
      const stop = yield* Effect.flip(Deferred.await(stopped))

      assert.instanceOf(error, SyncSnapshotUnreadable)
      assert.strictEqual(error.sequence, 1)
      assert.include(error.message, "stands for sequence 2")
      assert.strictEqual(stop, error)
    }))
})

describe("an entry in flight across a cut", () => {
  it.effect("does not apply a proposal twice when it was stored, cut away and sent again", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* cuttingHarness
      const host = yield* instanceOn(hostLog, false, { cut: { every: 2 } })
      const client = Context.get(yield* Layer.build(clientLog), SyncLog)
      const entry = yield* proposalEntry(2)
      yield* client.append(entry)
      yield* settle

      yield* client.append(entry)
      yield* settle
      const { entries } = yield* readLog(hostLog, 0)

      assert.deepStrictEqual(eventsOf(entries), [[2, "Snapshot"]])
      assert.deepStrictEqual(yield* countsOf(host), [0, 2])
    }))

  it.effect("releases a present whose entry was cut away before the instance read it", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* cuttingHarness
      const host = yield* instanceOn(hostLog, false, { cut: { every: 3 } })
      const subscribedFrom: Array<number> = []
      const writer = yield* instanceOn(droppedOnFirstProposal(lostAfter(clientLog, 2, subscribedFrom), true), false)
      yield* settle
      const presenting = yield* Effect.forkScoped(writer.model.present(inc(2)))
      yield* settle

      yield* TestClock.adjust("1 second")
      yield* Fiber.join(presenting)
      yield* settle
      const { entries } = yield* readLog(hostLog, 0)

      assert.deepStrictEqual(yield* countsOf(writer), [0, 2])
      assert.deepStrictEqual(yield* countsOf(host), [0, 2])
      assert.deepStrictEqual(eventsOf(entries), [[3, "Snapshot"]])
    }))
})

describe("the lease across a cut", () => {
  it.effect("stops the automatic actions of an instance whose snapshot names another holder", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* cuttingHarness
      const link = yield* openLink
      const reconnecting = subscribingWhileDelivering(linkedBy(clientLog, link), link)
      const former = yield* instanceOn(lostAfter(reconnecting, 4, []), true)
      const successor = yield* instanceOn(hostLog, true, { cut: { every: 5 } })
      yield* successor.model.present(inc(3))
      yield* settle
      yield* cutOff(link)
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("15 seconds")
      yield* settle

      yield* link.deliver.open
      yield* settle
      yield* link.write.open
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle
      const { entries } = yield* readLog(hostLog, 0)
      const automatic = entries.filter((remote) => remote.entry.event === "AutoProposal")

      assert.deepStrictEqual(yield* countsOf(former), [0, 3, 3, 0])
      assert.strictEqual(automatic.length, 1)
    }))

  it.effect("lets a joiner that starts from a snapshot claim only the epoch after the snapshot's", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* cuttingHarness
      const host = yield* stoppableOn(hostLog, true, { cut: { every: 2 } })
      yield* settle
      yield* host.stop
      yield* instanceOn(clientLog, true)

      yield* TestClock.adjust("16 seconds")
      yield* settle
      const { entries } = yield* readLog(hostLog, 0)
      const leases = entries.filter((remote) => remote.entry.event === "Lease")
      const epochs = yield* Effect.forEach(leases, (remote) => Effect.map(decodeLease(remote.entry.payload), (lease) => lease.epoch))

      assert.deepStrictEqual(epochs, [2])
    }))
})
