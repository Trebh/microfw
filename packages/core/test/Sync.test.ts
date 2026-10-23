import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Latch, Layer, Stream } from "effect"
import { EventJournal, EventLogRemote } from "effect/eventlog"
import { TestClock } from "effect/testing"
import { LogId, type LogSubscription, noLease, SyncLog, type SyncLogMismatch } from "../src/SyncEntry.ts"
import { Counter } from "./fixtures/Counter.ts"
import { countIs, countsOf, currentRepresentation, harness, instanceOn, loopOn, readLog } from "./fixtures/SyncHarness.ts"
import { awaitFirst, settle } from "./support.ts"

const inc = (by: number) => ({ _tag: "Inc", by }) as const
const reset = { _tag: "Reset" } as const

/** Wraps a log so that `append` waits for `latch`: a proposal formed on an instance that reaches the log late. */
const slowAppend = <E, R>(log: Layer.Layer<SyncLog, E, R>, latch: Latch.Latch) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const inner = yield* SyncLog
      return SyncLog.of({ ...inner, append: (entry) => latch.await.pipe(Effect.andThen(inner.append(entry))) })
    })
  ).pipe(Layer.provide(log))

/**
 * Wraps a log so that its first subscription ends in a loss after `delivered` entries; every
 * subscription's start sequence is pushed to `subscribedFrom`.
 */
const lostAfter = <E, R>(log: Layer.Layer<SyncLog, E, R>, delivered: number, subscribedFrom: Array<number>) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const inner = yield* SyncLog
      const lost = new EventLogRemote.EventLogRemoteError({ method: "changes", cause: "connection lost" })
      const cut = (subscription: LogSubscription): LogSubscription => ({
        log: subscription.log,
        entries: Stream.concat(subscription.entries.pipe(Stream.take(delivered)), Stream.fail(lost))
      })
      const follow = (from: number) =>
        Effect.suspend(() => {
          subscribedFrom.push(from)
          const isFirst = subscribedFrom.length === 1
          return Effect.map(inner.follow(from), (subscription) => isFirst ? cut(subscription) : subscription)
        })
      return SyncLog.of({ ...inner, follow })
    })
  ).pipe(Layer.provide(log))

const lostConnection = new EventLogRemote.EventLogRemoteError({ method: "write", cause: "connection lost" })

/**
 * Wraps a log so that the first append of a `Proposal` fails as a dropped connection does: the
 * entry reaches the log first when `stored` is true, and is lost on the way when it is false.
 */
const droppedOnFirstProposal = <E, R>(log: Layer.Layer<SyncLog, E, R>, stored: boolean) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const inner = yield* SyncLog
      let dropped = false
      const append = (entry: EventJournal.Entry) =>
        Effect.suspend(() => {
          if (entry.event !== "Proposal" || dropped) return inner.append(entry)
          dropped = true
          const sent = stored ? inner.append(entry) : Effect.void
          return sent.pipe(Effect.andThen(Effect.fail(lostConnection)))
        })
      return SyncLog.of({ ...inner, append })
    })
  ).pipe(Layer.provide(log))

/** Wraps a log so that every `Proposal` it appends carries a payload that does not decode. */
const corruptingProposals = <E, R>(log: Layer.Layer<SyncLog, E, R>) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const inner = yield* SyncLog
      const corrupt = (entry: EventJournal.Entry) =>
        entry.event !== "Proposal"
          ? entry
          : new EventJournal.Entry({
            id: entry.id,
            event: entry.event,
            primaryKey: entry.primaryKey,
            payload: Uint8Array.of(255, 255, 255)
          }, { disableChecks: true })
      return SyncLog.of({ ...inner, append: (entry) => inner.append(corrupt(entry)) })
    })
  ).pipe(Layer.provide(log))

describe("layerLoopSynced", () => {
  it.effect("applies on the other instance a proposal presented on this one", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      const b = yield* instanceOn(clientLog, false)

      yield* a.model.present(inc(2))

      const onB = yield* awaitFirst(b.model.representations, countIs(2))
      assert.deepStrictEqual(onB, { controlState: "low", count: 2 })
    }))

  it.effect("has applied a proposal on its own instance when present returns", () =>
    Effect.gen(function*() {
      const { clientLog } = yield* harness
      const b = yield* instanceOn(clientLog, false)

      yield* b.model.present(inc(2))

      assert.deepStrictEqual(yield* currentRepresentation(b), { controlState: "low", count: 2 })
    }))

  it.effect("applies each proposal exactly once per instance, with no echo", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      const b = yield* instanceOn(clientLog, false)

      yield* a.model.present(inc(1))
      yield* b.model.present(inc(1))
      yield* awaitFirst(a.model.representations, countIs(2))
      yield* settle

      assert.deepStrictEqual(yield* countsOf(a), [0, 1, 2])
      assert.deepStrictEqual(yield* countsOf(b), [0, 1, 2])
    }))

  it.effect("orders concurrent proposals by the log, not by where they were formed", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const late = yield* Latch.make(true)
      const a = yield* instanceOn(hostLog, false)
      const b = yield* instanceOn(slowAppend(clientLog, late), false)
      yield* a.model.present(inc(1))
      yield* awaitFirst(b.model.representations, countIs(1))
      yield* late.close

      yield* Effect.forkScoped(b.model.present(inc(4)))
      yield* settle
      yield* a.model.present(reset)
      yield* awaitFirst(b.model.representations, countIs(0))
      const beforeRelease = yield* currentRepresentation(b)
      yield* late.open
      yield* awaitFirst(b.model.representations, countIs(4))

      assert.deepStrictEqual(beforeRelease, { controlState: "low", count: 0 })
      assert.deepStrictEqual(yield* currentRepresentation(a), { controlState: "high", count: 4 })
      assert.deepStrictEqual(yield* countsOf(a), [0, 1, 0, 4])
      assert.deepStrictEqual(yield* countsOf(b), [0, 1, 0, 4])
    }))

  it.effect("serves a late joiner the model of the whole log", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      yield* a.model.present(inc(1))
      yield* a.model.present(inc(1))

      const joiner = yield* instanceOn(clientLog, false)

      assert.deepStrictEqual(yield* currentRepresentation(joiner), { controlState: "low", count: 2 })
      assert.deepStrictEqual(yield* countsOf(joiner), [0, 1, 2])
    }))

  it.effect("runs an automatic action only on the instance that has them enabled", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const leader = yield* instanceOn(hostLog, true)
      const follower = yield* instanceOn(clientLog, false)
      yield* follower.model.present(inc(3))
      yield* awaitFirst(leader.model.representations, countIs(3))
      yield* settle

      yield* TestClock.adjust("1 second")
      yield* awaitFirst(follower.model.representations, countIs(0))
      yield* settle

      assert.deepStrictEqual(yield* countsOf(follower), [0, 3, 0])
      assert.deepStrictEqual(yield* countsOf(leader), [0, 3, 0])
    }))

  it.effect("subscribes again from the next unapplied sequence when the log is lost", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const subscribedFrom: Array<number> = []
      const a = yield* instanceOn(hostLog, false)
      const b = yield* instanceOn(lostAfter(clientLog, 2, subscribedFrom), false)
      yield* settle

      yield* TestClock.adjust("1 second")
      yield* a.model.present(inc(1))
      yield* awaitFirst(b.model.representations, countIs(1))
      yield* settle

      assert.deepStrictEqual(subscribedFrom, [0, 3])
      assert.deepStrictEqual(yield* countsOf(b), [0, 1])
    }))

  it.effect("returns from present once the proposal is applied when the connection drops after the log stored it", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      const b = yield* instanceOn(droppedOnFirstProposal(clientLog, true), false)

      yield* b.model.present(inc(2))
      yield* TestClock.adjust("5 seconds")
      yield* settle

      assert.deepStrictEqual(yield* countsOf(a), [0, 2])
      assert.deepStrictEqual(yield* countsOf(b), [0, 2])
    }))

  it.effect("sends the same proposal again after a second when the connection drops before the log stored it", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      const b = yield* instanceOn(droppedOnFirstProposal(clientLog, false), false)
      const presenting = yield* Effect.forkScoped(b.model.present(inc(2)))
      yield* settle
      const beforeRetry = yield* countsOf(a)

      yield* TestClock.adjust("1 second")
      yield* Fiber.join(presenting)

      assert.deepStrictEqual(beforeRetry, [0])
      assert.deepStrictEqual(yield* countsOf(a), [0, 2])
      assert.deepStrictEqual(yield* countsOf(b), [0, 2])
    }))

  it.effect("dies on a refusal of the log instead of sending the proposal again", () =>
    Effect.gen(function*() {
      const { clientLog } = yield* harness
      const b = yield* instanceOn(corruptingProposals(clientLog), false)

      const exit = yield* Effect.exit(b.model.present(inc(2)))

      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
      assert.deepStrictEqual(yield* countsOf(b), [0])
    }))
})

/**
 * Wraps a log so that its first subscription is lost after `delivered` entries, and every later one
 * reports `replacement` as the log it follows, as a host restarted over a new log does.
 */
const replacedAfterLoss = <E, R>(log: Layer.Layer<SyncLog, E, R>, delivered: number, replacement: LogId) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const inner = yield* SyncLog
      const lost = new EventLogRemote.EventLogRemoteError({ method: "changes", cause: "connection lost" })
      let subscriptions = 0
      const follow = (from: number) =>
        Effect.suspend(() => {
          subscriptions += 1
          const isFirst = subscriptions === 1
          return Effect.map(inner.follow(from), (subscription): LogSubscription =>
            isFirst
              ? { log: subscription.log, entries: Stream.concat(subscription.entries.pipe(Stream.take(delivered)), Stream.fail(lost)) }
              : { log: replacement, entries: subscription.entries })
        })
      return SyncLog.of({ ...inner, follow })
    })
  ).pipe(Layer.provide(log))

const aLogOfItsOwn = LogId.make("0123456789abcdef0123456789abcdef")

describe("layerLoopSynced resuming from a checkpoint", () => {
  it.effect("applies only the entries after the checkpoint's sequence", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      yield* a.model.present(inc(2))
      yield* a.model.present(inc(3))
      const { log } = yield* readLog(hostLog, 0)

      const joiner = yield* instanceOn(clientLog, false, {
        resume: { log, sequence: 2, model: { count: 2 }, lease: noLease }
      })

      assert.deepStrictEqual(yield* countsOf(joiner), [2, 5])
    }))

  it.effect("ends equal to a joiner that replays the whole log", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      yield* a.model.present(inc(2))
      yield* a.model.present(inc(3))
      const { log } = yield* readLog(hostLog, 0)

      const resumed = yield* instanceOn(clientLog, false, {
        resume: { log, sequence: 2, model: { count: 2 }, lease: noLease }
      })
      const replayed = yield* instanceOn(clientLog, false)

      assert.deepStrictEqual(yield* currentRepresentation(resumed), { controlState: "high", count: 5 })
      assert.deepStrictEqual(yield* currentRepresentation(resumed), yield* currentRepresentation(replayed))
    }))

  it.effect("keeps following the log after it has caught up from the checkpoint", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      yield* a.model.present(inc(2))
      const { log } = yield* readLog(hostLog, 0)
      const resumed = yield* instanceOn(clientLog, false, {
        resume: { log, sequence: 2, model: { count: 2 }, lease: noLease }
      })

      yield* a.model.present(inc(1))

      assert.deepStrictEqual(yield* awaitFirst(resumed.model.representations, countIs(3)), {
        controlState: "high",
        count: 3
      })
    }))

  it.effect("fails the layer with SyncLogMismatch when the checkpoint belongs to another log", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const { log } = yield* readLog(hostLog, 0)

      const error = yield* Effect.flip(
        Layer.build(
          loopOn(clientLog, false, { resume: { log: aLogOfItsOwn, sequence: 2, model: { count: 2 }, lease: noLease } })
        )
      )

      assert.include(error as object, { _tag: "SyncLogMismatch", expected: aLogOfItsOwn, actual: log })
    }))

  it.effect("stops applying when a later subscription finds another log", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      const b = yield* instanceOn(replacedAfterLoss(clientLog, 2, aLogOfItsOwn), false)
      yield* settle

      yield* TestClock.adjust("1 second")
      yield* a.model.present(inc(1))
      yield* settle

      assert.deepStrictEqual(yield* countsOf(a), [0, 1])
      assert.deepStrictEqual(yield* countsOf(b), [0])
    }))

  it.effect("fails the caller's stopped signal with the mismatch when it stops applying", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const { log } = yield* readLog(hostLog, 0)
      const stopped = yield* Deferred.make<never, SyncLogMismatch>()
      yield* instanceOn(replacedAfterLoss(clientLog, 1, aLogOfItsOwn), false, { stopped })
      yield* settle

      yield* TestClock.adjust("1 second")
      const error = yield* Effect.flip(Deferred.await(stopped))

      assert.include(error as object, { _tag: "SyncLogMismatch", expected: log, actual: aLogOfItsOwn })
    }))

  it.effect("dies on present with SyncLogMismatch once it has stopped, instead of waiting for an entry nothing applies", () =>
    Effect.gen(function*() {
      const { clientLog } = yield* harness
      const b = yield* instanceOn(replacedAfterLoss(clientLog, 1, aLogOfItsOwn), false)
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle

      const exit = yield* Effect.exit(b.model.present(inc(1)))

      assert.isTrue(Exit.isFailure(exit))
      assert.include(Cause.squash((exit as Exit.Failure<void, never>).cause) as object, { _tag: "SyncLogMismatch" })
    }))
})

describe("layerSyncServer", () => {
  it.effect("refuses an entry whose payload does not decode as a proposal", () =>
    Effect.gen(function*() {
      const { clientLog } = yield* harness
      const log = Context.get(yield* Layer.build(clientLog), SyncLog)
      const entry = new EventJournal.Entry({
        id: EventJournal.makeEntryIdUnsafe({ msecs: 0 }),
        event: "Proposal",
        primaryKey: Counter.name,
        payload: Uint8Array.of(255, 255, 255)
      }, { disableChecks: true })

      const error = yield* Effect.flip(log.append(entry))

      assert.strictEqual(error._tag, "EventLogRemoteError")
    }))
})

describe("layerSyncAuthorization", () => {
  it.effect("refuses an entry with an event tag the log does not know", () =>
    Effect.gen(function*() {
      const { clientLog } = yield* harness
      const log = Context.get(yield* Layer.build(clientLog), SyncLog)
      const entry = new EventJournal.Entry({
        id: EventJournal.makeEntryIdUnsafe({ msecs: 0 }),
        event: "Bid",
        primaryKey: Counter.name,
        payload: Uint8Array.of(1)
      }, { disableChecks: true })

      const error = yield* Effect.flip(log.append(entry))

      assert.strictEqual(error._tag, "EventLogRemoteError")
      assert.include(error.cause as object, {
        _tag: "EventLogProtocolError",
        requestTag: "WriteEntries",
        code: "Unauthorized",
        message: "\"Bid\" is not an event of this log"
      })
    }))
})
