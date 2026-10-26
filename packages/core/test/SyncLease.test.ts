import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Option, Queue, Ref } from "effect"
import { EventJournal, EventLogMessage } from "effect/eventlog"
import { TestClock } from "effect/testing"
import { AutoEpoch } from "../src/index.ts"
import {
  applyLease,
  installLease,
  InstanceId,
  isCurrentEpoch,
  type Lease,
  leaseOutcome,
  type LeaseState,
  type LeaseTracker,
  SyncLog,
  type SyncCheckpoint,
  type SyncOptions
} from "../src/SyncEntry.ts"
import { Counter } from "./fixtures/Counter.ts"
import { countsOf, harness, instanceOn, readLog, stoppableOn } from "./fixtures/SyncHarness.ts"
import { cutOff, linkedBy, openLink } from "./fixtures/SyncLinks.ts"
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

  it("applies an automatic proposal that names the epoch the log is in", () => {
    assert.isTrue(isCurrentEpoch(heldBy(first, 2), 2))
  })

  it("skips an automatic proposal that names an epoch that is over", () => {
    assert.isFalse(isCurrentEpoch(heldBy(second, 2), 1))
  })

  it("skips an automatic proposal that names an epoch the log has not reached", () => {
    assert.isFalse(isCurrentEpoch(heldBy(first, 2), 3))
  })
})

const trackerHolding = (state: LeaseState) =>
  Effect.gen(function*() {
    return { id: first, state: yield* Ref.make(state), heardAt: yield* Ref.make(0) } satisfies LeaseTracker
  })

describe("installing the lease a snapshot carries", () => {
  it.effect("says a snapshot took the lease from the instance that held it, and replaces the state", () =>
    Effect.gen(function*() {
      const tracker = yield* trackerHolding(heldBy(first, 1))

      const change = yield* installLease(tracker, heldBy(second, 2))

      assert.deepStrictEqual(
        { change, state: yield* Ref.get(tracker.state) },
        { change: "lost", state: { epoch: 2, holder: second } }
      )
    }))

  it.effect("says a snapshot gave the lease to the instance that did not hold it, and replaces the state", () =>
    Effect.gen(function*() {
      const tracker = yield* trackerHolding(heldBy(second, 1))

      const change = yield* installLease(tracker, heldBy(first, 2))

      assert.deepStrictEqual(
        { change, state: yield* Ref.get(tracker.state) },
        { change: "gained", state: { epoch: 2, holder: first } }
      )
    }))

  it.effect("changes nothing for an instance that neither held nor holds the lease, and replaces the state", () =>
    Effect.gen(function*() {
      const tracker = yield* trackerHolding(heldBy(second, 1))

      const change = yield* installLease(tracker, { epoch: 3, holder: null })

      assert.deepStrictEqual(
        { change, state: yield* Ref.get(tracker.state) },
        { change: "none", state: { epoch: 3, holder: null } }
      )
    }))
})

/** The newest checkpoint an instance has offered. */
const checkpointsOf = (checkpoints: Queue.Queue<SyncCheckpoint<typeof Counter>>) =>
  Effect.map(Queue.clear(checkpoints), (all) => Option.getOrThrow(Option.fromUndefinedOr(all.at(-1))))

/**
 * A holder that is cut off from the log while its automatic action runs and finishes, and a successor that
 * claims the next epoch and runs an action of its own. Then only the holder's writes are let through, so
 * its finished action reaches the log after the successor's claim while the holder has still heard nothing.
 */
const deposedHolderWithLateAction = (successorOptions?: SyncOptions<typeof Counter>) =>
  Effect.gen(function*() {
    const { hostLog, clientLog } = yield* harness
    const link = yield* openLink
    const deposed = yield* instanceOn(linkedBy(clientLog, link), true)
    const successor = yield* instanceOn(hostLog, true, successorOptions)
    yield* deposed.model.present(inc(3))
    yield* settle
    yield* cutOff(link)
    yield* TestClock.adjust("1 second")
    yield* settle
    yield* TestClock.adjust("15 seconds")
    yield* settle
    yield* TestClock.adjust("1 second")
    yield* settle
    yield* link.write.open
    yield* settle
    return { hostLog, link, deposed, successor }
  })

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

  it.effect(
    "skips the proposal of an automatic action that finished under an epoch the log has since left, when it reaches the log after the successor's claim",
    () =>
      Effect.gen(function*() {
        const { link, deposed, successor } = yield* deposedHolderWithLateAction()

        yield* link.deliver.open
        yield* settle

        assert.deepStrictEqual(yield* countsOf(successor), [0, 3, 0])
        assert.deepStrictEqual(yield* countsOf(deposed), [0, 3, 0])
      })
  )

  it.effect("keeps the skipped proposal of a deposed holder in the log and moves the checkpoint past it", () =>
    Effect.gen(function*() {
      const checkpoints = yield* Queue.unbounded<SyncCheckpoint<typeof Counter>>()
      const { hostLog } = yield* deposedHolderWithLateAction({ checkpoints })

      const { entries } = yield* readLog(hostLog, 0)
      const automatic = entries.filter((remote) => remote.entry.event === "AutoProposal")
      const stale = Option.getOrThrow(Option.fromUndefinedOr(automatic.at(-1)))
      const offered = yield* Queue.clear(checkpoints)

      assert.strictEqual(automatic.length, 2)
      assert.include(offered.map((checkpoint) => checkpoint.sequence), stale.remoteSequence)
    }))

  it.effect("applies the proposal of a user intent from a deposed holder that reaches the log after the successor's claim", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const link = yield* openLink
      const deposed = yield* instanceOn(linkedBy(clientLog, link), true)
      const successor = yield* instanceOn(hostLog, true)
      yield* cutOff(link)
      const presenting = yield* Effect.forkScoped(deposed.model.present(inc(2)))

      yield* TestClock.adjust("15 seconds")
      yield* settle
      yield* link.write.open
      yield* settle
      yield* link.deliver.open
      yield* settle
      yield* Fiber.join(presenting)

      assert.deepStrictEqual(yield* countsOf(successor), [0, 2])
      assert.deepStrictEqual(yield* countsOf(deposed), [0, 2])
    }))
})

describe("automatic proposals and the epoch of the log", () => {
  it.effect("applies a proposal stamped with the epoch the instance holds", () =>
    Effect.gen(function*() {
      const { hostLog } = yield* harness
      const a = yield* instanceOn(hostLog, true)

      yield* a.model.present(inc(2)).pipe(Effect.provideService(AutoEpoch, Option.some(1)))

      assert.deepStrictEqual(yield* countsOf(a), [0, 2])
    }))

  it.effect("releases the caller of present when its stamped proposal is skipped, and leaves the model as it was", () =>
    Effect.gen(function*() {
      const { hostLog } = yield* harness
      const a = yield* instanceOn(hostLog, true)

      yield* a.model.present(inc(2)).pipe(Effect.provideService(AutoEpoch, Option.some(7)))

      assert.deepStrictEqual(yield* countsOf(a), [0])
    }))

  it.effect("offers a checkpoint past a skipped proposal", () =>
    Effect.gen(function*() {
      const { hostLog } = yield* harness
      const checkpoints = yield* Queue.unbounded<SyncCheckpoint<typeof Counter>>()
      const a = yield* instanceOn(hostLog, true, { checkpoints })

      yield* a.model.present(inc(2)).pipe(Effect.provideService(AutoEpoch, Option.some(7)))
      const checkpoint = yield* checkpointsOf(checkpoints)

      assert.deepStrictEqual({ sequence: checkpoint.sequence, count: checkpoint.model.count }, { sequence: 3, count: 0 })
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

describe("layerSyncAuthorization and layerSyncServer for lease and automatic-proposal entries", () => {
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

  it.effect("refuses an automatic-proposal entry whose payload does not decode", () =>
    Effect.gen(function*() {
      const { clientLog } = yield* harness
      const log = Context.get(yield* Layer.build(clientLog), SyncLog)
      const entry = new EventJournal.Entry({
        id: EventJournal.makeEntryIdUnsafe({ msecs: 0 }),
        event: "AutoProposal",
        primaryKey: Counter.name,
        payload: Uint8Array.of(255, 255, 255)
      }, { disableChecks: true })

      const error = yield* Effect.flip(log.append(entry))

      const refusal = Option.liftPredicate(error.cause, EventLogMessage.EventLogProtocolError.is)
      assert.deepStrictEqual(Option.map(refusal, (protocolError) => protocolError.code), Option.some("InternalServerError"))
    }))
})
