import { ActionFailure, AutoActionsGate, type IntentPortShape, makePorts, type ModelPortShape } from "@mufw/core"
import {
  layerLoopSynced,
  layerSyncAuthorization,
  layerSyncLogClient,
  layerSyncLogStorage,
  layerSyncServer,
  type SyncCheckpoint,
  SyncLog
} from "@mufw/core/sync"
import { Cause, Context, Effect, Exit, Layer, Option, Queue, Ref, Scope, Stream, SubscriptionRef } from "effect"
import {
  EventLogMessage,
  type EventJournal,
  EventLogRemote,
  EventLogServerUnencrypted
} from "effect/eventlog"
import { RpcTest } from "effect/rpc"
import { layerCurrentPatronFixed } from "../../adapters/currentPatronFixed.ts"
import { company, type Intent, Patron } from "../../domain/BoxOffice.ts"
import type { PaymentGateway } from "../../domain/PaymentGateway.ts"

/**
 * The box office both windows sell. The name is the log's store id, so two windows built from this
 * one definition are two instances of one log.
 */
export const Synced = company("Synced")

/**
 * One set of port keys serves both windows: each window is built by its own `Layer.build`, so each
 * gets a context of its own and the keys never meet.
 */
export const SyncedPorts = makePorts(Synced)

export type Side = "A" | "B"

export type Checkpoint = SyncCheckpoint<typeof Synced>

/** How often the holder of the lease writes a renewal, and how long silence lasts before another window claims it. */
export const LEASE_RENEW_MILLIS = 2000
export const LEASE_TIMEOUT_MILLIS = 6000

/** How long a proposal formed at window B spends on the slow line before it reaches the log. */
export const SLOW_LINE_MILLIS = 3000

const CHECKPOINT_BACKLOG = 8

/** One ticket window: a synced loop of its own, seen through its ports. */
export interface TicketWindow {
  readonly side: Side
  readonly patron: Patron
  readonly intents: IntentPortShape<typeof Synced>
  readonly model: ModelPortShape<typeof Synced>
  /** Whether this window holds the lease, as the actions drain asks it before every automatic intent. */
  readonly holdsChair: Effect.Effect<boolean>
  /** Where the window stands after every log entry it applies, the lease entries included. */
  readonly checkpoints: Stream.Stream<Checkpoint>
  /** Ends the window's scope, as closing a tab ends a process. */
  readonly close: Effect.Effect<void>
}

/** The two windows, the log between them and the levers the stage manager pulls. */
export class House extends Context.Service<House, {
  readonly windowA: SubscriptionRef.SubscriptionRef<Option.Option<TicketWindow>>
  readonly windowB: TicketWindow
  /** Every entry of the log from sequence 0, then the live ones, as the host's own storage delivers them. */
  readonly log: Stream.Stream<EventJournal.RemoteEntry, EventLogRemote.EventLogRemoteError>
  /** Whether proposals formed at window B wait `SLOW_LINE_MILLIS` before they reach the log. */
  readonly slowLine: Ref.Ref<boolean>
  /** How many of B's proposals are on the slow line now. */
  readonly onTheWire: SubscriptionRef.SubscriptionRef<number>
  readonly closeA: Effect.Effect<void>
  readonly reopenA: Effect.Effect<void, ActionFailure>
}>()("showcase/sync/House") {}

/** Hands an intent to a window's own loop; a local port never refuses one, and a refusal is logged. */
export const send = (window: TicketWindow, intent: Intent) =>
  window.intents.dispatch(intent).pipe(
    Effect.catchTag("DispatchRefused", (refused) => Effect.logWarning("intent refused", refused.intentTag, refused.message))
  )

interface Line {
  readonly slow: Ref.Ref<boolean>
  readonly onTheWire: SubscriptionRef.SubscriptionRef<number>
}

const lagged = <E>(line: Line, append: Effect.Effect<void, E>): Effect.Effect<void, E> =>
  Effect.gen(function*() {
    if (!(yield* Ref.get(line.slow))) return yield* append
    yield* SubscriptionRef.update(line.onTheWire, (count) => count + 1)
    yield* Effect.sleep(SLOW_LINE_MILLIS).pipe(
      Effect.andThen(append),
      Effect.ensuring(SubscriptionRef.update(line.onTheWire, (count) => count - 1))
    )
  })

/** `log` with its proposals held back while the line is slow; the lease and the join travel at full speed. */
const overSlowLine = <E, R>(log: Layer.Layer<SyncLog, E, R>, line: Line) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const inner = yield* SyncLog
      const append = (entry: EventJournal.Entry) =>
        entry.event === "Proposal" ? lagged(line, inner.append(entry)) : inner.append(entry)
      return SyncLog.of({ ...inner, append })
    })
  ).pipe(Layer.provide(log))

/**
 * One window: the synced loop over `log`, acting for `patron`, in a scope forked from the house's
 * so that it can end alone and ends with the house.
 */
const openWindow = <E, R>(side: Side, patron: Patron, log: Layer.Layer<SyncLog, E, R>, house: Scope.Scope) =>
  Effect.gen(function*() {
    const scope = yield* Scope.fork(house)
    const checkpoints = yield* Queue.sliding<Checkpoint>(CHECKPOINT_BACKLOG)
    const loop = layerLoopSynced(Synced, SyncedPorts, {
      lease: { renewEvery: LEASE_RENEW_MILLIS, timeout: LEASE_TIMEOUT_MILLIS },
      checkpoints
    }).pipe(Layer.provide(log), Layer.provide(layerCurrentPatronFixed(patron)))
    const context = yield* Layer.build(loop).pipe(
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void))
    )
    const window: TicketWindow = {
      side,
      patron,
      intents: Context.get(context, SyncedPorts.IntentPort),
      model: Context.get(context, SyncedPorts.ModelPort),
      holdsChair: Context.get(context, AutoActionsGate).open,
      checkpoints: Stream.fromQueue(checkpoints),
      close: Scope.close(scope, Exit.void)
    }
    return window
  })

/** Who each window acts for: the identity its actions read, never an intent's field. */
export const HORATIO = Patron.make("Horatio")
export const OPHELIA = Patron.make("Ophelia")

/**
 * The log server (in memory, over the same effect/eventlog handlers a remote host serves), window A
 * as the host's own process reading its storage, window B as a client over an in-process RPC
 * connection, and the slow line between B and the log. Returns once the doors are open.
 */
export const layerHouse = Layer.effect(
  House,
  Effect.gen(function*() {
    const house = yield* Effect.scope
    const paying = yield* Effect.context<PaymentGateway>()
    const server = layerSyncServer(Synced).pipe(
      Layer.provide(layerSyncAuthorization),
      Layer.provideMerge(EventLogServerUnencrypted.layerStorageMemory)
    )
    const built = Layer.succeedContext(yield* Layer.build(server))
    const rpcClient = Layer.effect(
      EventLogRemote.EventLogRemoteClient,
      RpcTest.makeClient(EventLogMessage.EventLogRemoteRpcs)
    )
    const hostLog = layerSyncLogStorage(Synced).pipe(Layer.provide(built))
    const clientLog = layerSyncLogClient(Synced).pipe(Layer.provide(rpcClient), Layer.provide(built))
    const line: Line = { slow: yield* Ref.make(false), onTheWire: yield* SubscriptionRef.make(0) }

    const first = yield* openWindow("A", HORATIO, hostLog, house)
    const windowA = yield* SubscriptionRef.make(Option.some(first))
    const windowB = yield* openWindow("B", OPHELIA, overSlowLine(clientLog, line), house)
    yield* send(first, { _tag: "OpenDoors" })
    yield* windowB.model.representations.pipe(
      Stream.filter((representation) => representation.controlState !== "dark"),
      Stream.runHead
    )

    const reader = Context.get(yield* Layer.build(hostLog), SyncLog)
    const log = Stream.unwrap(reader.follow(0).pipe(Effect.map(({ entries }) => entries)))

    const closeA = Effect.gen(function*() {
      const closing = yield* SubscriptionRef.getAndSet(windowA, Option.none())
      if (Option.isSome(closing)) yield* closing.value.close
    })
    const reopenA = Effect.gen(function*() {
      if (Option.isSome(yield* SubscriptionRef.get(windowA))) return
      const reopened = yield* openWindow("A", HORATIO, hostLog, house)
      yield* SubscriptionRef.set(windowA, Option.some(reopened))
    }).pipe(
      Effect.provideContext(paying),
      Effect.catch((error) =>
        Effect.logError("window A could not reopen", Cause.fail(error)).pipe(
          Effect.andThen(
            Effect.fail(new ActionFailure({ intentTag: "ReopenWindowA", message: "window A could not reopen" }))
          )
        )
      )
    )

    return House.of({
      windowA,
      windowB,
      log,
      slowLine: line.slow,
      onTheWire: line.onTheWire,
      closeA,
      reopenA
    })
  })
)
