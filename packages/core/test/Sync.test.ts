import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Latch, Layer, Option, Stream } from "effect"
import { EventJournal, EventLogMessage, EventLogRemote, EventLogServerUnencrypted } from "effect/eventlog"
import { TestClock } from "effect/testing"
import { LogId, type LogSubscription, layerSyncStorageMemory, noLease, SyncLog, type SyncStop } from "../src/SyncEntry.ts"
import { Counter } from "./fixtures/Counter.ts"
import { snapshotEntry } from "./fixtures/SnapshotEntries.ts"
import {
  countIs,
  countsOf,
  currentRepresentation,
  harness,
  harnessOver,
  instanceOn,
  loopOn,
  readLog
} from "./fixtures/SyncHarness.ts"
import { droppedOnFirstProposal, lostAfter } from "./fixtures/SyncLinks.ts"
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

describe("SyncLog.follow reports where the log ends", () => {
  it.effect("reports 0 for a log with no entry, over the host's storage", () =>
    Effect.gen(function*() {
      const { hostLog } = yield* harness

      const { last } = yield* readLog(hostLog, 0)

      assert.strictEqual(last, 0)
    }))

  it.effect("reports 0 for a log with no entry, over an event-log client", () =>
    Effect.gen(function*() {
      const { clientLog } = yield* harness

      const { last } = yield* readLog(clientLog, 0)

      assert.strictEqual(last, 0)
    }))

  it.effect("reports the sequence of the newest entry whether it was written in-process or over RPC", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      yield* instanceOn(clientLog, false)
      yield* a.model.present(inc(2))

      const overClient = yield* readLog(clientLog, 3)
      const overHost = yield* readLog(hostLog, 3)

      assert.strictEqual(overClient.last, 3)
      assert.strictEqual(overHost.last, 3)
    }))

  it.effect("reports the last sequence even when the subscription starts after it", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      yield* instanceOn(clientLog, false)
      yield* a.model.present(inc(2))

      const { last, entries } = yield* readLog(clientLog, 10)

      assert.strictEqual(last, 3)
      assert.deepStrictEqual(entries, [])
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
              ? { ...subscription, entries: Stream.concat(subscription.entries.pipe(Stream.take(delivered)), Stream.fail(lost)) }
              : { ...subscription, log: replacement })
        })
      return SyncLog.of({ ...inner, follow })
    })
  ).pipe(Layer.provide(log))

/**
 * Wraps a log so that its first subscription is lost after `delivered` entries, and every later one
 * reports a log with no entry, as a host restarted over a store that lost its entries does.
 */
const shorterAfterLoss = <E, R>(log: Layer.Layer<SyncLog, E, R>, delivered: number) =>
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
              ? { ...subscription, entries: Stream.concat(subscription.entries.pipe(Stream.take(delivered)), Stream.fail(lost)) }
              : { ...subscription, last: 0 })
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
      const stopped = yield* Deferred.make<never, SyncStop>()
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

  it.effect("fails the layer with SyncLogBehind when the log ends before the checkpoint, over the event-log client", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      yield* a.model.present(inc(2))
      const { log } = yield* readLog(hostLog, 0)

      const error = yield* Effect.flip(
        Layer.build(loopOn(clientLog, false, { resume: { log, sequence: 5, model: { count: 5 }, lease: noLease } }))
      )

      assert.include(error as object, { _tag: "SyncLogBehind", log, applied: 5, last: 2 })
    }))

  it.effect("fails the layer with SyncLogBehind when the log ends before the checkpoint, over the host's own storage", () =>
    Effect.gen(function*() {
      const { hostLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      yield* a.model.present(inc(2))
      const { log } = yield* readLog(hostLog, 0)

      const error = yield* Effect.flip(
        Layer.build(loopOn(hostLog, false, { resume: { log, sequence: 5, model: { count: 5 }, lease: noLease } }))
      )

      assert.include(error as object, { _tag: "SyncLogBehind", log, applied: 5, last: 2 })
    }))

  it.effect("fails the layer with SyncLogBehind when the checkpoint is one entry past the log's last", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      yield* a.model.present(inc(2))
      const { log } = yield* readLog(hostLog, 0)

      const error = yield* Effect.flip(
        Layer.build(loopOn(clientLog, false, { resume: { log, sequence: 3, model: { count: 3 }, lease: noLease } }))
      )

      assert.include(error as object, { _tag: "SyncLogBehind", log, applied: 3, last: 2 })
    }))

  it.effect("builds when the checkpoint is the log's last entry", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      yield* a.model.present(inc(2))
      const { log } = yield* readLog(hostLog, 0)

      const joiner = yield* instanceOn(clientLog, false, {
        resume: { log, sequence: 2, model: { count: 2 }, lease: noLease }
      })

      assert.deepStrictEqual(yield* countsOf(joiner), [2])
    }))

  it.effect("does not append to a log that ends before the checkpoint", () =>
    Effect.gen(function*() {
      const { hostLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      yield* a.model.present(inc(2))
      const { log } = yield* readLog(hostLog, 0)
      yield* Effect.flip(
        Layer.build(loopOn(hostLog, false, { resume: { log, sequence: 5, model: { count: 5 }, lease: noLease } }))
      )

      const { entries } = yield* readLog(hostLog, 0)

      assert.deepStrictEqual(entries.map((remote) => [remote.remoteSequence, remote.entry.event]), [
        [1, "Joined"],
        [2, "Proposal"]
      ])
    }))

  it.effect("fails the caller's stopped signal with SyncLogBehind when a later subscription finds the log shorter", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const { log } = yield* readLog(hostLog, 0)
      const stopped = yield* Deferred.make<never, SyncStop>()
      const a = yield* instanceOn(hostLog, false)
      yield* a.model.present(inc(2))
      const b = yield* instanceOn(shorterAfterLoss(clientLog, 3), false, { stopped })
      yield* settle

      yield* TestClock.adjust("1 second")
      const error = yield* Effect.flip(Deferred.await(stopped))

      assert.include(error as object, { _tag: "SyncLogBehind", log, applied: 3, last: 0 })
      assert.deepStrictEqual(yield* countsOf(b), [0, 2])
    }))

  it.effect("reports SyncLogMismatch, not SyncLogBehind, when both the id and the length are wrong", () =>
    Effect.gen(function*() {
      const { hostLog, clientLog } = yield* harness
      const a = yield* instanceOn(hostLog, false)
      yield* a.model.present(inc(2))

      const error = yield* Effect.flip(
        Layer.build(
          loopOn(clientLog, false, { resume: { log: aLogOfItsOwn, sequence: 9, model: { count: 9 }, lease: noLease } })
        )
      )

      assert.include(error as object, { _tag: "SyncLogMismatch" })
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

  it.effect("answers Sync.Head to a client that has not authenticated", () =>
    Effect.gen(function*() {
      const { syncClient } = yield* harness

      const answer = yield* syncClient["Sync.Head"]()

      assert.strictEqual(answer.remoteId.length, 16)
      assert.strictEqual(answer.last, 0)
    }))
})

describe("layerSyncServer refusing a Snapshot", () => {
  it.effect("refuses a Snapshot even when the authorization admits every entry, and stores nothing", () =>
    Effect.gen(function*() {
      const admitsEverything = Layer.succeed(EventLogServerUnencrypted.EventLogServerAuthorization, {
        authorizeWrite: () => Effect.void,
        authorizeRead: () => Effect.void,
        authorizeIdentity: () => Effect.void
      })
      const { hostLog, clientLog } = yield* harnessOver(layerSyncStorageMemory(Counter), admitsEverything)
      const log = Context.get(yield* Layer.build(clientLog), SyncLog)

      const error = yield* Effect.flip(log.append(yield* snapshotEntry(1)))
      const stored = yield* readLog(hostLog, 0)

      const refusal = Option.liftPredicate(error.cause, EventLogMessage.EventLogProtocolError.is)
      assert.strictEqual(error._tag, "EventLogRemoteError")
      assert.deepStrictEqual(
        Option.map(refusal, (protocolError) => [protocolError.code, protocolError.message]),
        Option.some(["InternalServerError", "Persistence failure"])
      )
      assert.deepStrictEqual({ last: stored.last, entries: stored.entries.length }, { last: 0, entries: 0 })
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
        message: "\"Bid\" is not an event a client may write to this log"
      })
    }))

  it.effect("refuses a Snapshot written by a client", () =>
    Effect.gen(function*() {
      const { clientLog } = yield* harness
      const log = Context.get(yield* Layer.build(clientLog), SyncLog)

      const error = yield* Effect.flip(log.append(yield* snapshotEntry(1)))

      assert.strictEqual(error._tag, "EventLogRemoteError")
      assert.include(error.cause as object, {
        _tag: "EventLogProtocolError",
        requestTag: "WriteEntries",
        code: "Unauthorized",
        message: "\"Snapshot\" is not an event a client may write to this log"
      })
    }))
})
