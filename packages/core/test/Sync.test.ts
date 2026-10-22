import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit, Fiber, Latch, Layer, Option, Stream } from "effect"
import { EventJournal, EventLogMessage, EventLogRemote } from "effect/eventlog"
import { RpcTest } from "effect/rpc"
import { TestClock } from "effect/testing"
import {
  AutoActions,
  type HistoryPortShape,
  layerLoopSynced,
  layerSyncLogClient,
  layerSyncLogStorage,
  layerSyncAuthorization,
  layerSyncServer,
  type ModelPortShape,
  SyncLog
} from "../src/index.ts"
import { Counter, Ports } from "./fixtures/Counter.ts"
import { awaitFirst, collect, settle } from "./support.ts"

const inc = (by: number) => ({ _tag: "Inc", by }) as const
const reset = { _tag: "Reset" } as const

/**
 * One log server (in-memory storage, the event-log RPC handlers) and the two ways an instance
 * reaches it: the server's own process reads and writes its storage; another process is an
 * event-log client over an in-process connection to the handlers.
 */
const harness = Effect.gen(function*() {
  const context = yield* Layer.build(layerSyncServer(Counter).pipe(Layer.provide(layerSyncAuthorization)))
  const server = Layer.succeedContext(context)
  const rpcClient = Layer.effect(EventLogRemote.EventLogRemoteClient, RpcTest.makeClient(EventLogMessage.EventLogRemoteRpcs))
  return {
    hostLog: layerSyncLogStorage(Counter).pipe(Layer.provide(server)),
    clientLog: layerSyncLogClient(Counter).pipe(Layer.provide(rpcClient), Layer.provide(server))
  }
})

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
      const entries = (from: number) => {
        subscribedFrom.push(from)
        const isFirst = subscribedFrom.length === 1
        const cut = Stream.concat(inner.entries(from).pipe(Stream.take(delivered)), Stream.fail(lost))
        return isFirst ? cut : inner.entries(from)
      }
      return SyncLog.of({ ...inner, entries })
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

interface Instance {
  readonly model: ModelPortShape<typeof Counter>
  readonly history: HistoryPortShape<typeof Counter>
}

const instanceOn = <E, R>(log: Layer.Layer<SyncLog, E, R>, autoActions: boolean) =>
  Layer.build(
    layerLoopSynced(Counter, Ports).pipe(Layer.provide(log), Layer.provide(Layer.succeed(AutoActions, autoActions)))
  ).pipe(
    Effect.map((context): Instance => ({
      model: Context.get(context, Ports.ModelPort),
      history: Context.get(context, Ports.HistoryPort)
    }))
  )

const currentRepresentation = (instance: Instance) =>
  Stream.runHead(instance.model.representations).pipe(Effect.map(Option.getOrThrow))

const countIs = (count: number) => (representation: { readonly count: number }) => representation.count === count

/** The count of every record the instance holds, the initial one first. */
const countsOf = (instance: Instance) =>
  collect(instance.history.records).pipe(Effect.map((records) => records.map((record) => record.model.count)))

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
