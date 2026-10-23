import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Latch, Layer, Option, Queue, Stream } from "effect"
import { EventJournal } from "effect/eventlog"
import { TestClock } from "effect/testing"
import {
  applyLease,
  InstanceId,
  type Lease,
  leaseOutcome,
  type LeaseState,
  SyncLog,
  type SyncCheckpoint
} from "../src/SyncEntry.ts"
import { Counter } from "./fixtures/Counter.ts"
import { countsOf, harness, instanceOn, stoppableOn } from "./fixtures/SyncHarness.ts"
import { settle } from "./support.ts"

const inc = (by: number) => ({ _tag: "Inc", by }) as const

const first = InstanceId.make("11111111111111111111111111111111")
const second = InstanceId.make("22222222222222222222222222222222")

const heldBy = (holder: InstanceId, epoch: number): LeaseState => ({ epoch, holder })
const claim = (holder: InstanceId, epoch: number): Lease => ({ epoch, holder })

describe("the lease rule", () => {
  it("lets a claim for the next epoch take the lease", () => {
    const state = applyLease(heldBy(first, 1), claim(second, 2))

    assert.deepStrictEqual(state, { epoch: 2, holder: second })
  })

  it("lets a claim take a log nobody has claimed", () => {
    const state = applyLease({ epoch: 0, holder: null }, claim(first, 1))

    assert.deepStrictEqual(state, { epoch: 1, holder: first })
  })

  it("ignores a second claim for an epoch that already has a holder", () => {
    const state = applyLease(heldBy(first, 2), claim(second, 2))

    assert.deepStrictEqual(state, { epoch: 2, holder: first })
  })

  it("ignores a claim for an epoch that skips one", () => {
    const state = applyLease(heldBy(first, 1), claim(second, 3))

    assert.deepStrictEqual(state, { epoch: 1, holder: first })
  })

  it("ignores a claim for an epoch that is over", () => {
    const state = applyLease(heldBy(first, 3), claim(second, 2))

    assert.deepStrictEqual(state, { epoch: 3, holder: first })
  })

  it("counts a renewal from the holder in the current epoch", () => {
    assert.strictEqual(leaseOutcome(heldBy(first, 2), claim(first, 2)), "renewed")
  })

  it("ignores a renewal from a holder of an earlier epoch", () => {
    assert.strictEqual(leaseOutcome(heldBy(second, 2), claim(first, 1)), "ignored")
  })

  it("ignores a renewal from an instance that does not hold the current epoch", () => {
    assert.strictEqual(leaseOutcome(heldBy(first, 2), claim(second, 2)), "ignored")
  })
})

/** The two directions of an instance's link to the log: entries delivered to it, and entries it writes. */
interface Link {
  readonly deliver: Latch.Latch
  readonly write: Latch.Latch
}

/** Wraps a log so that, while a latch of `link` is closed, the entries it guards are held, not lost. */
const linkedBy = <E, R>(log: Layer.Layer<SyncLog, E, R>, link: Link) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const inner = yield* SyncLog
      const held = (entries: Stream.Stream<EventJournal.RemoteEntry, any>) =>
        Stream.mapEffect(entries, (entry) => Effect.as(link.deliver.await, entry))
      return SyncLog.of({
        append: (entry) => link.write.await.pipe(Effect.andThen(inner.append(entry))),
        follow: (from) => Effect.map(inner.follow(from), (subscription) => ({ ...subscription, entries: held(subscription.entries) }))
      })
    })
  ).pipe(Layer.provide(log))

const openLink = Effect.gen(function*() {
  return { deliver: yield* Latch.make(true), write: yield* Latch.make(true) } satisfies Link
})

const cutOff = (link: Link) => Effect.andThen(link.deliver.close, link.write.close)

/** The newest checkpoint an instance has offered. */
const checkpointsOf = (checkpoints: Queue.Queue<SyncCheckpoint<typeof Counter>>) =>
  Effect.map(Queue.clear(checkpoints), (all) => Option.getOrThrow(Option.fromUndefinedOr(all.at(-1))))

describe("automatic actions across instances", () => {
  it.effect("runs a tick on one instance only when two take part", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, true)
      const b = yield* instanceOn(clientLog, true)

      yield* b.model.present(inc(3))
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle

      assert.deepStrictEqual(yield* countsOf(a), [0, 3, 0])
      assert.deepStrictEqual(yield* countsOf(b), [0, 3, 0])
    }))

  it.effect("leaves the automatic actions to the instance that has taken the lease, whichever joined first", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const earlier = yield* instanceOn(clientLog, true)
      const later = yield* instanceOn(hostLog, true)

      yield* later.model.present(inc(3))
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle

      assert.deepStrictEqual(yield* countsOf(earlier), [0, 3, 0])
      assert.deepStrictEqual(yield* countsOf(later), [0, 3, 0])
    }))

  it.effect("keeps the epoch of the lease while the holder renews it, however long that is", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const checkpoints = yield* Queue.unbounded<SyncCheckpoint<typeof Counter>>()
      yield* instanceOn(hostLog, true)
      yield* instanceOn(clientLog, true, { checkpoints })

      yield* TestClock.adjust("60 seconds")
      yield* settle

      assert.strictEqual((yield* checkpointsOf(checkpoints)).lease.epoch, 1)
    }))

  it.effect("runs the tick on the instance that takes part when another one does not", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const bystander = yield* instanceOn(hostLog, false)
      const b = yield* instanceOn(clientLog, true)

      yield* bystander.model.present(inc(3))
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle

      assert.deepStrictEqual(yield* countsOf(bystander), [0, 3, 0])
      assert.deepStrictEqual(yield* countsOf(b), [0, 3, 0])
    }))

  it.effect("starts no tick on any instance while the holder is silent and the timeout has not passed", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const holder = yield* stoppableOn(hostLog, true)
      const b = yield* instanceOn(clientLog, true)
      yield* holder.stop

      yield* TestClock.adjust("10 seconds")
      yield* b.model.present(inc(3))
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle

      assert.deepStrictEqual(yield* countsOf(b), [0, 3])
    }))

  it.effect("takes over after the timeout when the holder stops, and ticks for the state it is in", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const holder = yield* stoppableOn(hostLog, true)
      const b = yield* instanceOn(clientLog, true)
      yield* b.model.present(inc(3))
      yield* holder.stop

      yield* TestClock.adjust("15 seconds")
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle

      assert.deepStrictEqual(yield* countsOf(b), [0, 3, 0])
    }))

  it.effect("makes one instance the holder when two claim the same epoch at once", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const holder = yield* stoppableOn(hostLog, true)
      const b = yield* instanceOn(clientLog, true)
      const c = yield* instanceOn(clientLog, true)
      yield* holder.stop

      yield* TestClock.adjust("15 seconds")
      yield* settle
      yield* b.model.present(inc(3))
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle

      assert.deepStrictEqual(yield* countsOf(b), [0, 3, 0])
      assert.deepStrictEqual(yield* countsOf(c), [0, 3, 0])
    }))

  it.effect("does not run automatic actions on a holder that was deposed while cut off from the log, once it is back", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const link = yield* openLink
      const deposed = yield* instanceOn(linkedBy(clientLog, link), true)
      const b = yield* instanceOn(hostLog, true)
      yield* cutOff(link)
      yield* TestClock.adjust("15 seconds")
      yield* settle
      yield* link.deliver.open
      yield* link.write.open
      yield* settle

      yield* b.model.present(inc(3))
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle

      assert.deepStrictEqual(yield* countsOf(deposed), [0, 3, 0])
      assert.deepStrictEqual(yield* countsOf(b), [0, 3, 0])
    }))

  it.effect("drops the automatic action in flight of a holder that applies the entry deposing it, before it presents", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const link = yield* openLink
      const deposed = yield* instanceOn(linkedBy(clientLog, link), true)
      const b = yield* instanceOn(hostLog, true)
      yield* deposed.model.present(inc(3))
      yield* settle
      yield* link.write.close
      yield* TestClock.adjust("1 second")
      yield* link.deliver.close
      yield* TestClock.adjust("15 seconds")
      yield* settle
      yield* link.deliver.open
      yield* settle
      yield* link.write.open
      yield* settle

      yield* TestClock.adjust("1 second")
      yield* settle

      assert.deepStrictEqual(yield* countsOf(deposed), [0, 3, 0])
      assert.deepStrictEqual(yield* countsOf(b), [0, 3, 0])
    }))

  it.effect("lets a deposed holder run automatic actions again once it claims a later epoch", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const link = yield* openLink
      const deposed = yield* instanceOn(linkedBy(clientLog, link), true)
      const successor = yield* stoppableOn(hostLog, true)
      yield* cutOff(link)
      yield* TestClock.adjust("15 seconds")
      yield* settle
      yield* link.deliver.open
      yield* link.write.open
      yield* settle
      yield* successor.stop

      yield* TestClock.adjust("20 seconds")
      yield* settle
      yield* deposed.model.present(inc(3))
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle

      assert.deepStrictEqual(yield* countsOf(deposed), [0, 3, 0])
    }))

  it.effect("keeps a lease entry out of the history: only proposals are records", () =>
    Effect.gen(function*() {
      const { hostLog } = yield* harness
      const a = yield* instanceOn(hostLog, true)

      yield* TestClock.adjust("20 seconds")
      yield* settle

      assert.deepStrictEqual(yield* countsOf(a), [0])
    }))
})

describe("the lease in a checkpoint", () => {
  it.effect("holds the lease the instance has applied, with the epoch and the holder that won it", () =>
    Effect.gen(function*() {
      const { hostLog } = yield* harness
      const checkpoints = yield* Queue.unbounded<SyncCheckpoint<typeof Counter>>()
      yield* instanceOn(hostLog, true, { checkpoints })

      const checkpoint = yield* checkpointsOf(checkpoints)

      assert.strictEqual(checkpoint.lease.epoch, 1)
      assert.match(checkpoint.lease.holder ?? "", /^[0-9a-f]{32}$/)
    }))

  it.effect("lets an instance that resumes from it claim the next epoch of a holder it never saw claim", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const checkpoints = yield* Queue.unbounded<SyncCheckpoint<typeof Counter>>()
      const holder = yield* stoppableOn(hostLog, true, { checkpoints })
      const checkpoint = yield* checkpointsOf(checkpoints)
      yield* holder.stop
      const resumed = yield* instanceOn(clientLog, true, { resume: checkpoint })
      yield* resumed.model.present(inc(3))

      yield* TestClock.adjust("15 seconds")
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle

      assert.deepStrictEqual(yield* countsOf(resumed), [0, 3, 0])
    }))

  it.effect("does not let an instance that resumes believe it holds the lease its earlier run held", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const checkpoints = yield* Queue.unbounded<SyncCheckpoint<typeof Counter>>()
      const earlier = yield* stoppableOn(hostLog, true, { checkpoints })
      const checkpoint = yield* checkpointsOf(checkpoints)
      yield* earlier.stop
      const resumed = yield* instanceOn(clientLog, true, { resume: checkpoint })

      yield* resumed.model.present(inc(3))
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle

      assert.deepStrictEqual(yield* countsOf(resumed), [0, 3])
    }))
})

describe("layerSyncAuthorization and layerSyncServer for lease entries", () => {
  it.effect("refuses a lease entry whose payload does not decode", () =>
    Effect.gen(function*() {
      const { clientLog } = yield* harness
      const log = Context.get(yield* Layer.build(clientLog), SyncLog)
      const entry = new EventJournal.Entry({
        id: EventJournal.makeEntryIdUnsafe({ msecs: 0 }),
        event: "Lease",
        primaryKey: Counter.name,
        payload: Uint8Array.of(255, 255, 255)
      }, { disableChecks: true })

      const error = yield* Effect.flip(log.append(entry))

      assert.strictEqual(error._tag, "EventLogRemoteError")
    }))
})
