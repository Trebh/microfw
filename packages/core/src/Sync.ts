import { Cause, Clock, Context, Deferred, Effect, Layer, Option, Queue, Ref, Schedule, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { Hex } from "effect/encoding"
import {
  Event,
  EventGroup,
  EventJournal,
  EventLog,
  EventLogEncryption,
  EventLogMessage,
  EventLogRemote,
  EventLogServerUnencrypted
} from "effect/eventlog"
import type { AnyDefinition, ModelOf, ProposalOf } from "./Definition.ts"
import {
  AutoActions,
  AutoActionsGate,
  AutoEpoch,
  layerActionRunnerLocal,
  layerActionsDrain,
  layerIntentBus,
  makeLocalModel
} from "./Layers.ts"
import type { ModelPortShape, Ports } from "./Ports.ts"
import { layerSyncHeadHandlers, SyncClient, SyncHead } from "./SyncHead.ts"
import {
  defaultLeaseTimings,
  Epoch,
  installLease,
  isCurrentEpoch,
  keepLease,
  Lease,
  type LeaseChange,
  type LeaseState,
  type LeaseTimings,
  type LeaseTracker,
  makeLeaseTracker,
  nextClaim,
  observeLease
} from "./SyncLease.ts"
import {
  idStringOf,
  type LogCut,
  makeCutter,
  SNAPSHOT,
  type Snapshot,
  snapshotPayload,
  type SyncCutOptions,
  SyncCutUnsupported,
  SyncSnapshotUnreadable,
  SyncStorageCut
} from "./SyncSnapshot.ts"

const PROPOSAL = "Proposal"
const AUTO_PROPOSAL = "AutoProposal"
const JOINED = "Joined"
const LEASE = "Lease"
const ENTRY_EVENTS = [PROPOSAL, AUTO_PROPOSAL, JOINED, LEASE]

/** One store per definition, so two definitions never share a log. */
export const syncStoreId = (def: AnyDefinition) => EventLogMessage.StoreId.make(def.name)

/**
 * The identity of a log: the 16 random bytes its server generated when the log was created and
 * keeps with it, in lowercase hex. Sequences mean something only within one log, so whoever keeps
 * a sequence keeps this next to it.
 */
export const LogId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{32}$/, { expected: "32 lowercase hex digits" })),
  Schema.brand("LogId")
)
export type LogId = typeof LogId.Type

/**
 * An instance holds, or is offered, a log that is not the one it joined: a sequence it kept, or the
 * entries it applied, belong to another log (the host's storage was replaced). Applying anything
 * from it would give this instance a model the other instances' history cannot explain.
 */
export class SyncLogMismatch extends Schema.TaggedError<SyncLogMismatch>()("SyncLogMismatch", {
  expected: LogId,
  actual: LogId,
  message: Schema.String
}) {}

/**
 * The log this instance follows ends before an entry the instance has already applied: the log lost
 * its newest entries (a store that lost a write, a restored backup). What it appends from now on
 * takes sequences this instance has seen, so the instance would never be given those entries.
 */
export class SyncLogBehind extends Schema.TaggedError<SyncLogBehind>()("SyncLogBehind", {
  log: LogId,
  /** The newest sequence this instance applied. */
  applied: Schema.Natural,
  /** The newest sequence the log holds. */
  last: Schema.Natural,
  message: Schema.String
}) {}

/** Why an instance stops applying its log. */
export type SyncStop = SyncLogMismatch | SyncLogBehind | SyncSnapshotUnreadable

const logIdOf = (remoteId: Uint8Array, method: string) =>
  Schema.decodeUnknownEffect(LogId)(Hex.encode(remoteId)).pipe(
    Effect.mapError((cause) => new EventLogRemote.EventLogRemoteError({ method, cause }))
  )

const proposalEvent = <D extends AnyDefinition>(def: D) => {
  const payload: Schema.Codec<ProposalOf<D>, unknown> = def.proposal
  return Event.make({ tag: PROPOSAL, primaryKey: () => def.name, payload })
}

/** The payload of an `AutoProposal` entry: a proposal that an automatic action produced, and the epoch it ran under. */
export const autoProposalSchema = <D extends AnyDefinition>(def: D) => {
  const proposal: Schema.Codec<ProposalOf<D>, unknown> = def.proposal
  return Schema.Struct({ epoch: Epoch, proposal })
}

const autoProposalEvent = <D extends AnyDefinition>(def: D) =>
  Event.make({ tag: AUTO_PROPOSAL, primaryKey: () => def.name, payload: autoProposalSchema(def) })

/**
 * The events a definition's log holds. `Proposal` carries a proposal, encoded with the
 * definition's `proposal` schema. `AutoProposal` carries a proposal that an automatic action produced
 * and the epoch the action started under (`autoProposalSchema`). `Joined` carries nothing: an instance
 * writes one to learn when it has replayed everything the log held before it. `Lease` carries a `Lease`:
 * who claims or renews the ownership of automatic actions, and for which epoch.
 * `Snapshot` carries the log's state after a sequence (`snapshotPayload`): only a cut writes one, and
 * it is the first entry of a log that has been cut.
 */
export const syncGroup = <D extends AnyDefinition>(def: D) => {
  const payload: Schema.Codec<ProposalOf<D>, unknown> = def.proposal
  return EventGroup.empty
    .add({ tag: PROPOSAL, primaryKey: () => def.name, payload })
    .add({ tag: AUTO_PROPOSAL, primaryKey: () => def.name, payload: autoProposalSchema(def) })
    .add({ tag: JOINED, primaryKey: () => def.name })
    .add({ tag: LEASE, primaryKey: () => def.name, payload: Lease })
    .add({ tag: SNAPSHOT, primaryKey: () => def.name, payload: snapshotPayload(def) })
}

/** The entries of one log from a sequence on, which log they belong to, and where that log ends. */
export interface LogSubscription {
  readonly log: LogId
  /** The sequence of the newest entry the log held when the subscription was opened; 0 for a log with none. */
  readonly last: number
  readonly entries: Stream.Stream<EventJournal.RemoteEntry, EventLogRemote.EventLogRemoteError>
}

/**
 * The sequencer of a synced loop: an ordered, append-only log shared by every instance, which
 * keeps its sequences and its identity for as long as it exists. `follow(from)` subscribes to the
 * entries with a sequence of at least `from`, in sequence order, the instance's own included, then
 * live ones, and says which log it subscribed to and where that log ends; the subscription ends
 * with the scope. The order is the log's alone: every instance sees the same sequence of entries.
 * `cut` is there when the log's owner can cut it (the host's, over `layerSyncStorage`): see `SyncOptions.cut`.
 */
export class SyncLog extends Context.Service<SyncLog, {
  readonly append: (entry: EventJournal.Entry) => Effect.Effect<void, EventLogRemote.EventLogRemoteError>
  readonly follow: (from: number) => Effect.Effect<LogSubscription, EventLogRemote.EventLogRemoteError, Scope.Scope>
  readonly cut?: LogCut
}>()("@mufw/core/SyncLog") {}

/**
 * Where an instance stands in a log: the model it holds and the lease it has applied are the log's
 * state after `sequence`. A lease belongs in the checkpoint because an instance that resumes reads
 * only the entries after `sequence`, and the claims before it decide what a later renewal means.
 */
export interface SyncCheckpoint<D extends AnyDefinition> {
  readonly log: LogId
  readonly sequence: number
  readonly model: ModelOf<D>
  readonly lease: LeaseState
}

export interface SyncOptions<D extends AnyDefinition> {
  /**
   * The state of the log this instance already holds, restored from where the instance kept it: the
   * loop starts from `model` and reads the log from the entry after `sequence`. The log must be
   * `log` and must hold the entry at `sequence`, else building the layer fails with `SyncLogMismatch`
   * or `SyncLogBehind`.
   */
  readonly resume?: SyncCheckpoint<D>
  /**
   * Receives the checkpoint after every entry the instance applies, an entry that changes nothing
   * included, never waiting for the receiver: give it a sliding queue, so that a slow writer costs the
   * loop nothing.
   */
  readonly checkpoints?: Queue.Enqueue<SyncCheckpoint<D>>
  /**
   * Fails with the `SyncStop` (`SyncLogMismatch`, `SyncLogBehind`, `SyncSnapshotUnreadable`) when the
   * instance stops applying because the log it follows is no longer the one it joined, ends before an
   * entry it applied, or holds a snapshot the instance cannot read, so whoever owns the process can
   * wait on it and stop the process.
   * Given by the caller, since nothing built inside the layer can reach the process's main fiber.
   */
  readonly stopped?: Deferred.Deferred<never, SyncStop>
  /**
   * How the ownership of automatic actions is kept: see `LeaseTimings`. Only an instance whose
   * `AutoActions` is true takes part in it.
   */
  readonly lease?: LeaseTimings
  /**
   * Cuts the log: once the instance has applied `cut.every` entries past the log's last cut, the log
   * replaces the entries up to the sequence just applied by a `Snapshot` of this instance's model
   * and lease at that sequence. Only the host's log, over `layerSyncStorage`, can cut: over any other
   * log building the layer fails with `SyncCutUnsupported`, before anything is applied. Every
   * instance of the log must understand `Snapshot` before it is enabled.
   */
  readonly cut?: SyncCutOptions
}

const encodeEntry = (
  event: string,
  primaryKey: string,
  payload: Effect.Effect<Uint8Array, Schema.SchemaError>
) =>
  Effect.gen(function*() {
    const bytes = yield* Effect.orDie(payload)
    const msecs = yield* Clock.currentTimeMillis
    const id = EventJournal.makeEntryIdUnsafe({ msecs })
    return new EventJournal.Entry({ id, event, primaryKey, payload: bytes }, { disableChecks: true })
  })

/** The encoded form of one definition's log entries. */
interface Wire<D extends AnyDefinition> {
  readonly proposalEntry: (proposal: ProposalOf<D>) => Effect.Effect<EventJournal.Entry>
  readonly autoProposalEntry: (epoch: number, proposal: ProposalOf<D>) => Effect.Effect<EventJournal.Entry>
  readonly joinedEntry: Effect.Effect<EventJournal.Entry>
  readonly leaseEntry: (lease: Lease) => Effect.Effect<EventJournal.Entry>
  readonly decodeProposal: (entry: EventJournal.Entry) => Effect.Effect<ProposalOf<D>, Schema.SchemaError>
  readonly decodeAutoProposal: (
    entry: EventJournal.Entry
  ) => Effect.Effect<{ readonly epoch: number; readonly proposal: ProposalOf<D> }, Schema.SchemaError>
  readonly decodeLease: (entry: EventJournal.Entry) => Effect.Effect<Lease, Schema.SchemaError>
  readonly decodeSnapshot: (entry: EventJournal.Entry) => Effect.Effect<Snapshot<D>, Schema.SchemaError>
}

const makeWire = <D extends AnyDefinition>(def: D): Wire<D> => {
  const proposal = proposalEvent(def)
  const autoProposal = autoProposalEvent(def)
  const joined = Event.make({ tag: JOINED, primaryKey: () => def.name })
  const lease = Event.make({ tag: LEASE, primaryKey: () => def.name, payload: Lease })
  const snapshot = Event.make({ tag: SNAPSHOT, primaryKey: () => def.name, payload: snapshotPayload(def) })
  const encodeProposal = Schema.encodeUnknownEffect(proposal.payloadSchemaBinary)
  const encodeAutoProposal = Schema.encodeUnknownEffect(autoProposal.payloadSchemaBinary)
  const encodeJoined = Schema.encodeUnknownEffect(joined.payloadSchemaBinary)
  const encodeLease = Schema.encodeUnknownEffect(lease.payloadSchemaBinary)
  const decodeProposal = Schema.decodeUnknownEffect(proposal.payloadSchemaBinary)
  const decodeAutoProposal = Schema.decodeUnknownEffect(autoProposal.payloadSchemaBinary)
  const decodeLease = Schema.decodeUnknownEffect(lease.payloadSchemaBinary)
  const decodeSnapshot = Schema.decodeUnknownEffect(snapshot.payloadSchemaBinary)
  return {
    proposalEntry: (value) => encodeEntry(PROPOSAL, def.name, encodeProposal(value)),
    autoProposalEntry: (epoch, value) =>
      encodeEntry(AUTO_PROPOSAL, def.name, encodeAutoProposal({ epoch, proposal: value })),
    joinedEntry: encodeEntry(JOINED, def.name, encodeJoined(undefined)),
    leaseEntry: (value) => encodeEntry(LEASE, def.name, encodeLease(value)),
    decodeProposal: (entry) => decodeProposal(entry.payload),
    decodeAutoProposal: (entry) => decodeAutoProposal(entry.payload),
    decodeLease: (entry) => decodeLease(entry.payload),
    decodeSnapshot: (entry) => decodeSnapshot(entry.payload)
  }
}

type Waiting = Map<string, Deferred.Deferred<void>>

/**
 * Appends `entry` until the log has taken it. A failure whose cause is not an answer of the server
 * (the connection dropped with the write in flight) leaves it unknown whether the entry was
 * stored, so the same entry is sent again a second later: the event-log server drops an entry
 * whose id it holds, which makes the retry safe. An answer of the server is a refusal (an
 * authorization or decode failure) that sending again would not change, and it ends the retries.
 */
const appendUntilStored = (log: SyncLog["Service"], entry: EventJournal.Entry) =>
  log.append(entry).pipe(
    Effect.retry({
      schedule: Schedule.spaced("1 second"),
      while: (error) => !EventLogMessage.EventLogProtocolError.is(error.cause)
    })
  )

/**
 * Appends `entry`, then waits until the applier has applied it: the caller continues once the
 * proposal is part of this instance's model, in the log's order. An entry the log delivered
 * before the append was confirmed counts as appended. Fails with the log's refusal.
 */
const appendAndAwait = (log: SyncLog["Service"], waiting: Waiting, entry: EventJournal.Entry) => {
  const id = entry.idString
  return Effect.gen(function*() {
    const applied = yield* Deferred.make<void>()
    waiting.set(id, applied)
    yield* Effect.raceFirst(appendUntilStored(log, entry), Deferred.await(applied))
    yield* Deferred.await(applied)
  }).pipe(Effect.ensuring(Effect.sync(() => void waiting.delete(id))))
}

/** How far this instance has read, and the log it has been reading. */
interface Position {
  /** The next unapplied sequence. */
  readonly next: Ref.Ref<number>
  /** `none` until the first subscription says which log this is, unless the instance resumed one. */
  readonly log: Ref.Ref<Option.Option<LogId>>
}

/** What applying one log entry needs. */
interface Applier<D extends AnyDefinition> {
  readonly wire: Wire<D>
  readonly replica: Replica<D>
  readonly lease: LeaseTracker
  readonly waiting: Waiting
  readonly position: Position
  readonly checkpoints: Queue.Enqueue<SyncCheckpoint<D>> | undefined
  readonly cutter: ((checkpoint: SyncCheckpoint<D>) => Effect.Effect<void>) | undefined
}

/**
 * Applies one log entry in the order the log delivers them: a proposal through the replica's
 * `present`, a lease entry through the lease rule, a snapshot by replacing the model and the lease
 * with the ones it carries. An `AutoProposal` is applied only when its epoch is the one the lease has
 * reached at that entry; otherwise it is skipped and changes nothing. A proposal that does not decode,
 * or whose acceptor dies, and a lease entry that does not decode are logged and skipped: every
 * instance reads the same entry and skips it alike, so they still agree. A snapshot that does not
 * decode, or that stands for another sequence than the one it is delivered at, fails with
 * `SyncSnapshotUnreadable`: skipping it would leave a model no other instance has. An entry that
 * takes the lease from this instance interrupts its automatic actions before the next entry is
 * applied (a snapshot does so before the model moves, so an action in flight never presents on the
 * old one); one that gives it the lease runs `nap` again for the state the instance is in, since the
 * intents `nap` returned while it did not hold the lease were dropped, and a snapshot does so
 * whatever it changes. Once the entry is applied or skipped the checkpoint is offered, to the
 * checkpoint queue and to the cutter, then the caller waiting for the entry is released; a snapshot
 * also releases every caller waiting for an entry it stands for.
 */
const makeApply = <D extends AnyDefinition>(applier: Applier<D>) => {
  const { wire, replica, lease, waiting, position, checkpoints, cutter } = applier
  const guarded = (entry: EventJournal.Entry, effect: Effect.Effect<void, Schema.SchemaError>) =>
    effect.pipe(
      Effect.catch((error) => Effect.logError("log entry not decoded", entry.idString, Cause.fail(error))),
      Effect.catchDefect((defect) => Effect.logError("log entry not applied", entry.idString, Cause.die(defect)))
    )
  const applyProposal = (entry: EventJournal.Entry) =>
    guarded(entry, wire.decodeProposal(entry).pipe(Effect.flatMap((proposal) => replica.port.present(proposal))))
  const presentIfCurrent = (entry: EventJournal.Entry, epoch: number, proposal: ProposalOf<D>) =>
    Effect.flatMap(Ref.get(lease.state), (state) =>
      isCurrentEpoch(state, epoch)
        ? replica.port.present(proposal)
        : Effect.logInfo(
          "proposal of an automatic action skipped: its epoch is not the log's",
          entry.idString,
          epoch,
          state.epoch
        ))
  const applyAutoProposal = (entry: EventJournal.Entry) =>
    guarded(
      entry,
      wire.decodeAutoProposal(entry).pipe(
        Effect.flatMap(({ epoch, proposal }) => presentIfCurrent(entry, epoch, proposal))
      )
    )
  const reactToChange = (change: LeaseChange) => {
    if (change === "lost") {
      return Effect.logInfo("this instance lost the lease: its automatic actions in flight are interrupted").pipe(
        Effect.andThen(replica.interruptAuto)
      )
    }
    if (change === "gained") {
      return Effect.logInfo("this instance took the lease: it runs automatic actions").pipe(
        Effect.andThen(replica.napAgain)
      )
    }
    return Effect.void
  }
  const applyLeaseEntry = (entry: EventJournal.Entry) =>
    wire.decodeLease(entry).pipe(
      Effect.flatMap((claim) => observeLease(lease, claim)),
      Effect.flatMap(reactToChange),
      Effect.catch((error) => Effect.logError("log entry not decoded", entry.idString, Cause.fail(error)))
    )
  const acknowledge = (id: string) => {
    const waiter = waiting.get(id)
    return waiter === undefined ? Effect.void : Deferred.succeed(waiter, undefined)
  }
  const unreadable = (remote: EventJournal.RemoteEntry, message: string) =>
    new SyncSnapshotUnreadable({
      sequence: remote.remoteSequence,
      message: `the snapshot at sequence ${remote.remoteSequence} ${message}`
    })
  const restoreFrom = (snapshot: Snapshot<D>) =>
    Effect.gen(function*() {
      const change = yield* installLease(lease, snapshot.lease)
      if (change === "lost") yield* replica.interruptAuto
      yield* replica.restore(snapshot.model)
      yield* replica.napAgain
      yield* Effect.forEach(snapshot.applied, (id) => acknowledge(idStringOf(id)), { discard: true })
    })
  const applySnapshot = (remote: EventJournal.RemoteEntry) =>
    wire.decodeSnapshot(remote.entry).pipe(
      Effect.mapError((cause) => unreadable(remote, `does not decode: ${cause.message}`)),
      Effect.filterOrFail(
        (snapshot) => snapshot.through === remote.remoteSequence,
        (snapshot) => unreadable(remote, `says it stands for sequence ${snapshot.through}`)
      ),
      Effect.flatMap(restoreFrom)
    )
  const applyEntry = (remote: EventJournal.RemoteEntry) => {
    const entry = remote.entry
    if (entry.event === PROPOSAL) return applyProposal(entry)
    if (entry.event === AUTO_PROPOSAL) return applyAutoProposal(entry)
    if (entry.event === LEASE) return applyLeaseEntry(entry)
    if (entry.event === SNAPSHOT) return applySnapshot(remote)
    return Effect.void
  }
  const offerCheckpoint = (sequence: number) =>
    Effect.gen(function*() {
      if (checkpoints === undefined && cutter === undefined) return
      const log = yield* Ref.get(position.log)
      if (Option.isNone(log)) return
      const model = yield* replica.model
      const state = yield* Ref.get(lease.state)
      const checkpoint = { log: log.value, sequence, model, lease: state }
      if (checkpoints !== undefined) yield* Queue.offer(checkpoints, checkpoint)
      if (cutter !== undefined) yield* cutter(checkpoint)
    })
  return (remote: EventJournal.RemoteEntry) =>
    Effect.gen(function*() {
      yield* applyEntry(remote)
      yield* Ref.set(position.next, remote.remoteSequence + 1)
      yield* offerCheckpoint(remote.remoteSequence)
      yield* acknowledge(remote.entry.idString)
    })
}

/** The first subscription says which log the instance is reading; every later one must say the same. */
const verifyLog = (joined: Ref.Ref<Option.Option<LogId>>, actual: LogId) =>
  Effect.gen(function*() {
    const expected = yield* Ref.get(joined)
    if (Option.isNone(expected)) return yield* Ref.set(joined, Option.some(actual))
    if (expected.value !== actual) {
      return yield* new SyncLogMismatch({
        expected: expected.value,
        actual,
        message: `the log is ${actual}, not ${expected.value} that this instance joined: its stored sequence and model belong to another log`
      })
    }
  })

/** A log that ends before the entry this instance applied is not read: `from - 1` is that entry's sequence. */
const verifyReach = (log: LogId, from: number, last: number) => {
  if (last >= from - 1) return Effect.void
  return Effect.fail(
    new SyncLogBehind({
      log,
      applied: from - 1,
      last,
      message: `the log ends at sequence ${last}, before ${from - 1}, which this instance applied: the log lost its newest entries, and the entries it appends under those sequences would never reach this instance; start it without its checkpoint to replay the log`
    })
  )
}

/** The log's identity first: the length of another log means nothing. */
const verifySubscription = (position: Position, from: number, subscription: LogSubscription) =>
  Effect.andThen(
    verifyLog(position.log, subscription.log),
    verifyReach(subscription.log, from, subscription.last)
  )

type FailedStopped = Deferred.Deferred<never, SyncStop>

/** What the subscriptions tell the rest of the instance. */
interface FollowSignals {
  /** Fails with the reason when a subscription is refused. */
  readonly stopped: FailedStopped
  /** Completes when the first subscription has been accepted. */
  readonly opened: Deferred.Deferred<void>
}

const noEntries: LogSubscription["entries"] = Stream.empty

const stopMessage = {
  SyncLogMismatch: "sync log replaced, this instance stopped applying",
  SyncLogBehind: "sync log ends before this instance's checkpoint, this instance stopped applying",
  SyncSnapshotUnreadable: "sync log snapshot cannot be read, this instance stopped applying"
} as const satisfies Record<SyncStop["_tag"], string>

/** Records why the instance stops and fails `stopped` with it. */
const stopApplying = (stopped: FailedStopped, error: SyncStop) =>
  Effect.logError(stopMessage[error._tag], Cause.fail(error)).pipe(Effect.andThen(Deferred.fail(stopped, error)))

/**
 * From the next unapplied sequence, again after every loss of the log, for as long as the scope
 * lives. A subscription to a log other than the joined one, or to one that ends before the entry
 * this instance applied, is not read: `stopped` fails with the reason and the stream ends, so the
 * instance applies nothing more.
 */
const followLog = (log: SyncLog["Service"], position: Position, signals: FollowSignals) => {
  const subscribe = Effect.gen(function*() {
    const from = yield* Ref.get(position.next)
    const subscription = yield* log.follow(from)
    yield* verifySubscription(position, from, subscription)
    yield* Deferred.succeed(signals.opened, undefined)
    return subscription.entries
  })
  const stop = (error: SyncStop) => Effect.as(stopApplying(signals.stopped, error), noEntries)
  return Stream.unwrap(Effect.catchTag(subscribe, ["SyncLogMismatch", "SyncLogBehind"], stop)).pipe(
    Stream.tapError((error) => Effect.logWarning("sync log lost, subscribing again", Cause.fail(error))),
    Stream.retry(Schedule.spaced("1 second"))
  )
}

/** The local model as `makeLocalModel` returns it, and the controls of the automatic actions that run beside it. */
interface Replica<D extends AnyDefinition> {
  readonly port: ModelPortShape<D>
  readonly model: Effect.Effect<ModelOf<D>>
  /** Runs `nap` for the state the model is in now. */
  readonly napAgain: Effect.Effect<void>
  /** Interrupts the automatic actions in flight. */
  readonly interruptAuto: Effect.Effect<void>
  /** Replaces the model by the one a snapshot carries, without running `nap`. */
  readonly restore: (model: ModelOf<D>) => Effect.Effect<void>
}

/**
 * Takes part in the lease of a log. An instance that finds a log nobody has ever claimed appends the
 * first claim and waits until it is applied, so the lease is decided when the layer is built; on a
 * log that has had a holder the holder is whoever the log says, and this instance claims the next
 * epoch only after hearing nothing for the timeout. The keeper runs for as long as the scope lives.
 */
const takePartInLease = <D extends AnyDefinition>(
  wire: Wire<D>,
  log: SyncLog["Service"],
  waiting: Waiting,
  tracker: LeaseTracker,
  timings: LeaseTimings
) =>
  Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    yield* Ref.set(tracker.heardAt, now)
    const state = yield* Ref.get(tracker.state)
    if (state.epoch === 0) yield* appendAndAwait(log, waiting, yield* wire.leaseEntry(yield* nextClaim(tracker)))
    const append = (lease: Lease) => Effect.flatMap(wire.leaseEntry(lease), (entry) => log.append(entry))
    yield* Effect.forkScoped(keepLease(tracker, timings, append))
  })

/**
 * The cutter `options.cut` asks for: none without it, and a failure when the log cannot cut, so a
 * declaration nothing honours never builds.
 */
const cutterOver = <D extends AnyDefinition>(log: SyncLog["Service"], cut: SyncCutOptions | undefined) => {
  if (cut === undefined) return Effect.succeed(undefined)
  if (log.cut === undefined) {
    return Effect.fail(
      new SyncCutUnsupported({ message: "this instance's log cannot be cut: only the host over layerSyncStorage can" })
    )
  }
  return makeCutter<D>(log.cut, cut)
}

/**
 * Starts the applier and returns once it has replayed every entry the log held when this was
 * called: a `Joined` entry is appended and awaited, and entries are applied in sequence order, so
 * everything before it has been applied by then. The `Joined` entry is appended once the first
 * subscription is accepted, so a log the instance refuses is never written. An instance with
 * `AutoActions` true then takes part in the lease. Fails when the log refuses an append, with
 * `SyncLogMismatch` when the log is not the one the instance resumed, with `SyncLogBehind` when
 * it ends before the checkpoint, with `SyncSnapshotUnreadable` when a snapshot it reads cannot be
 * applied, and with `SyncCutUnsupported` when `options.cut` is given over a log that cannot cut,
 * before anything is applied; after a stop `present` dies with the same error rather than
 * wait for an entry nothing will apply. `present` writes an `AutoProposal` when `AutoEpoch` names an
 * epoch and a `Proposal` otherwise; `gate` admits an automatic intent under the epoch this instance
 * holds, and none while it does not hold the lease.
 */
const makeSequencer = <D extends AnyDefinition>(
  def: D,
  log: SyncLog["Service"],
  replica: Replica<D>,
  options: SyncOptions<D> | undefined
) =>
  Effect.gen(function*() {
    const resume = options?.resume
    const position: Position = {
      next: yield* Ref.make(resume === undefined ? 0 : resume.sequence + 1),
      log: yield* Ref.make(Option.fromUndefinedOr(resume?.log))
    }
    const waiting: Waiting = new Map()
    const stopped = options?.stopped ?? (yield* Deferred.make<never, SyncStop>())
    const opened = yield* Deferred.make<void>()
    const wire = makeWire(def)
    const tracker = yield* makeLeaseTracker(resume?.lease)
    const cutter = yield* cutterOver<D>(log, options?.cut)
    const apply = makeApply({
      wire,
      replica,
      lease: tracker,
      waiting,
      position,
      checkpoints: options?.checkpoints,
      cutter
    })
    const untilStopped = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.raceFirst(effect, Deferred.await(stopped))
    const applying = Stream.runForEach(followLog(log, position, { stopped, opened }), apply).pipe(
      Effect.catchTag("SyncSnapshotUnreadable", (error) => stopApplying(stopped, error))
    )
    yield* Effect.forkScoped(applying)
    yield* untilStopped(Deferred.await(opened))
    yield* untilStopped(appendAndAwait(log, waiting, yield* wire.joinedEntry))
    if (yield* AutoActions) {
      yield* untilStopped(takePartInLease(wire, log, waiting, tracker, options?.lease ?? defaultLeaseTimings))
    }
    const entryFor = (epoch: Option.Option<number>, proposal: ProposalOf<D>) =>
      Option.match(epoch, {
        onNone: () => wire.proposalEntry(proposal),
        onSome: (stamp) => wire.autoProposalEntry(stamp, proposal)
      })
    const present = (proposal: ProposalOf<D>) =>
      Effect.gen(function*() {
        const epoch = yield* AutoEpoch
        const entry = yield* entryFor(epoch, proposal)
        yield* untilStopped(appendAndAwait(log, waiting, entry))
      }).pipe(Effect.orDie)
    const admit = Effect.map(Ref.get(tracker.state), (state) =>
      state.holder === tracker.id ? Option.some(state.epoch) : Option.none())
    return { present, gate: AutoActionsGate.of({ admit }) }
  })

/**
 * The loop of one instance of a definition that runs on several. The log is the sequencer: the
 * instance never applies a proposal it produces. `ModelPort.present` appends the proposal to the
 * `SyncLog` and returns once the log has delivered it back and the model has applied it; every
 * instance applies every entry, in the log's order, through a local model that only this layer
 * reaches. Acceptors need not commute: the instances agree because they apply the same proposals
 * in the same order, from the same initial model.
 *
 * - A proposal applied from the log is never appended again (the applier calls the local model,
 *   not the exposed port), so there is no echo.
 * - Actions run on the instance that received the intent; only proposals travel.
 * - Catch-up: without `options.resume` the log is replayed from its first entry; with it, from the
 *   entry after the checkpoint's sequence, on top of the checkpoint's model. Either way the layer is
 *   built once the instance has applied everything the log held when it joined. A log that ends
 *   before the checkpoint's sequence is not read (`SyncLogBehind`) and nothing is appended to it.
 * - A log that has been cut starts with a `Snapshot`, which every instance that has not applied up
 *   to the cut receives as its first entry: it replaces its model and its lease with the snapshot's
 *   (a history record of kind `restore`), runs `nap` again, releases the `present` of every entry the
 *   snapshot stands for, and goes on with the entries after it. An instance whose checkpoint is at or
 *   after the cut never receives it. A snapshot that does not decode, or that stands for another
 *   sequence than the one it is delivered at, stops the instance (`SyncSnapshotUnreadable`).
 * - Only the host cuts, and only when `options.cut` says so: its loop hands the checkpoint it has just
 *   built to the cutter, which asks the log (`SyncLog.cut`) to replace the entries up to that
 *   sequence by a `Snapshot`, in a fiber of the layer's scope, once `cut.every` entries have been
 *   applied since the log's last cut. A failed cut is logged and tried again `cut.every` entries
 *   later. Every instance of the log must understand `Snapshot` before it is enabled: one that does not
 *   ignores it and diverges.
 * - The log's identity is checked at every subscription: the first one fixes it (a resumed
 *   checkpoint brings it), and a later one that finds another log stops the instance. The log's end
 *   is checked next, at every subscription too: one that finds the log ending before the entry this
 *   instance applied stops it. A snapshot that cannot be read stops it too. Building the layer fails
 *   with `SyncLogMismatch`, `SyncLogBehind` or `SyncSnapshotUnreadable` when that happens before it is
 *   built; afterwards the applier stops, an error is logged, `options.stopped` fails with it and
 *   `present` dies with the same error.
 * - Automatic actions are owned by one instance at a time, and the log decides which. `nap` runs on
 *   every instance, but its intents run only on the one that holds the lease: an `AutoActionsGate`
 *   this layer provides, which the actions drain asks. An instance with `AutoActions` true takes part
 *   (`false`: it never runs automatic actions, never claims); the first to build against a log nobody
 *   has claimed appends `Lease { epoch: 1, holder }`, the holder renews it every `lease.renewEvery`,
 *   and an instance that has applied no lease entry for `lease.timeout` by its own `Clock` claims
 *   the next epoch. Every instance applies lease entries in log order by one rule (`leaseOutcome`: a
 *   claim wins only for the epoch after the current one, a renewal counts only from the current
 *   holder), so exactly one holder exists at each position of the log. The instance that applies an
 *   entry taking the lease from it interrupts its automatic actions in flight before it applies
 *   anything else, and one that applies its own winning claim runs `nap` again, since the intents
 *   `nap` returned until then were dropped. An automatic action's proposal is written as
 *   `AutoProposal { epoch, proposal }`, the epoch being the one the gate admitted the action under when
 *   it started; every instance applies it only if that is the epoch the log is in at that entry's
 *   position, so the proposal of a deposed holder that reaches the log after the successor's claim
 *   stays in the log and is skipped by all; a user intent's proposal is a `Proposal` and is always
 *   applied. An instance's identity lasts as long as its layer:
 *   a restarted instance holds nothing until it wins an epoch. The lease state is part of the
 *   checkpoint (`SyncCheckpoint.lease`), and lease entries change no model and make no history record.
 * - `HistoryPort.travelTo` and `HistoryPort.replay` move one instance's model away from the log;
 *   do not serve them. Until one of them, instances hold records with the same `seq` and model for
 *   each applied proposal that started from the same model; only `at`, the local commit time, differs.
 *   On a host that cuts they are worse than a divergence: the snapshot carries the host's model, moved
 *   or not, to every instance that joins from it.
 * - A lost connection is not a failure of `present`: it sends the same entry again every second
 *   until the log has it, and returns as soon as the entry has been applied, so it waits for as
 *   long as the log is out of reach. It dies only when the log refuses the entry.
 *
 * A model restored from elsewhere than a checkpoint or a snapshot of this log would not be the log's:
 * the loop starts from `def.initial` or from `options.resume`, nothing else.
 */
export const layerLoopSynced = <D extends AnyDefinition, R = never>(
  def: D,
  ports: Ports<D, R>,
  options?: SyncOptions<D>
) => {
  const sequenced = Layer.effectContext(
    Effect.gen(function*() {
      const log = yield* SyncLog
      const bus = yield* ports.IntentBus
      const resume = options?.resume
      const local = yield* makeLocalModel(def, bus, resume === undefined ? undefined : { initial: resume.model })
      const replica = { ...local, interruptAuto: bus.interruptAuto }
      const sequencer = yield* makeSequencer(def, log, replica, options)
      const port: ModelPortShape<D> = { present: sequencer.present, representations: local.port.representations }
      return Context.make(ports.ModelPort, port).pipe(
        Context.add(ports.HistoryPort, local.port),
        Context.add(AutoActionsGate, sequencer.gate)
      )
    })
  )
  return layerActionsDrain(def, ports).pipe(
    Layer.provideMerge(Layer.merge(sequenced, layerActionRunnerLocal(def, ports))),
    Layer.provideMerge(layerIntentBus(def, ports))
  )
}

/**
 * The log of a server's own process: appends to and reads the server's `Storage` directly, in
 * the same transaction and the same sequence as the entries clients write over RPC. The log's
 * identity is the storage's own id, and where it ends is what the storage's `SyncHead` says. The
 * head is read before the subscription opens: an older head can only report the log as behind,
 * and a log that was behind and has grown since is a fork, not one to join. It can cut when the
 * storage provides `SyncStorageCut` (`layerSyncStorage`).
 */
export const layerSyncLogStorage = (def: AnyDefinition) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const storage = yield* EventLogServerUnencrypted.Storage
      const head = yield* SyncHead
      const cut = Option.getOrUndefined(yield* Effect.serviceOption(SyncStorageCut))
      const storeId = syncStoreId(def)
      const follow = (from: number) =>
        Effect.gen(function*() {
          const log = yield* logIdOf(yield* storage.getId, "id")
          const last = yield* head.last
          const entries = storage.changes({ storeId, startSequence: from, compactors: new Map() })
          return { log, last, entries }
        })
      return SyncLog.of({
        append: (entry) => Effect.asVoid(storage.withTransaction(storage.write(storeId, [entry]))),
        follow,
        cut
      })
    })
  )

/**
 * The log of an event-log server reached through `SyncClient`, under an identity generated for
 * this layer's lifetime. Building it fails with `EventLogRemoteError` when the server's handshake
 * fails. Each subscription asks the server for its id and its last sequence (`Sync.Head`) after
 * the subscription is open: a server replaced in between has dropped the connection the
 * subscription is on, which the next subscription then checks.
 */
export const layerSyncLogClient = (def: AnyDefinition) => {
  const storeId = syncStoreId(def)
  const identity = Layer.effect(EventLog.Identity, EventLog.makeIdentity).pipe(
    Layer.provide(EventLogEncryption.layerSubtle)
  )
  const stock = Layer.effect(EventLogRemote.EventLogRemoteClient, SyncClient)
  const remote = Layer.effect(EventLogRemote.EventLogRemote, EventLogRemote.makeUnencrypted).pipe(
    Layer.provide(EventLog.layerRegistry),
    Layer.provide(stock)
  )
  return Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const remote = yield* EventLogRemote.EventLogRemote
      const client = yield* SyncClient
      const identity = yield* EventLog.Identity
      // A host that does not serve `SyncRpcs` answers an unknown tag with a defect, not an error:
      // it surfaces as a failed subscription, which is retried with the cause in the warning.
      const head = client["Sync.Head"]().pipe(
        Effect.mapError((cause) => new EventLogRemote.EventLogRemoteError({ method: "head", cause })),
        Effect.catchDefect((cause) => Effect.fail(new EventLogRemote.EventLogRemoteError({ method: "head", cause })))
      )
      const follow = (from: number) =>
        Effect.gen(function*() {
          const queue = yield* remote.changes({ identity, storeId, startSequence: from })
          const answer = yield* head
          const log = yield* logIdOf(answer.remoteId, "head")
          return { log, last: answer.last, entries: Stream.fromQueue(queue) }
        })
      return SyncLog.of({
        append: (entry) => remote.write({ identity, storeId, entries: [entry] }),
        follow
      })
    })
  ).pipe(Layer.provide(Layer.merge(identity, remote)))
}

/** `layerSyncLogClient` over the client protocol in context, which carries `SyncRpcs`. */
export const layerSyncLogRemote = (def: AnyDefinition) =>
  layerSyncLogClient(def).pipe(Layer.provide(SyncClient.layer))

/**
 * Admits every identity to read the store, and a write only if every entry is a `Proposal`, an
 * `AutoProposal`, a `Joined` or a `Lease` event: the events a client may write. A `Snapshot` is an
 * event of the log (`syncGroup`) that only the host's cut writes, so it is refused too. The
 * event-log server stores an entry whose tag has no handler without looking at it, so this is what
 * keeps a writer from putting anything else in the log.
 * It does not say who may write: the endpoint it guards is a back channel between instances, and
 * whoever can write to it can append any proposal, which every instance applies. Serve that
 * endpoint to trusted instances only.
 * Marked pure so that a bundle that imports `@mufw/core` without running a server drops the
 * event-log modules.
 */
export const layerSyncAuthorization = /*#__PURE__*/ Layer.succeed(
  EventLogServerUnencrypted.EventLogServerAuthorization,
  {
    authorizeWrite: ({ publicKey, storeId, entries }) => {
      const unknown = entries.find((entry) => !ENTRY_EVENTS.includes(entry.event))
      if (unknown === undefined) return Effect.void
      return Effect.fail(
        new EventLogServerUnencrypted.EventLogServerAuthError({
          reason: "Forbidden",
          publicKey,
          storeId,
          message: `"${unknown.event}" is not an event a client may write to this log`
        })
      )
    },
    authorizeRead: () => Effect.void,
    authorizeIdentity: () => Effect.void
  }
)

/**
 * The server side of the log for one definition: the `SyncRpcs` handlers (serve them with
 * `RpcServer.layer(SyncRpcs)`, whose protocol and serialization the application picks) over the
 * `Storage` and `SyncHead` in context, which the log lives in: memory (`layerSyncStorageMemory`,
 * gone with the process) or a persistent one (`layerSyncStorage`). A joiner reads the log's end
 * through `Sync.Head`, which a host serving only `EventLogRemoteRpcs` does not answer. The caller
 * provides the storage with `Layer.provideMerge` when it is also read in-process
 * (`layerSyncLogStorage`).
 * Only `Proposal`, `AutoProposal`, `Joined`, `Lease` and `Snapshot` entries have a handler: a `Proposal` is decoded with the
 * definition's `proposal` schema, an `AutoProposal` with `autoProposalSchema` and a `Lease` with its own, and each is refused when it does not decode;
 * a `Snapshot` is refused always, since only the cut writes one. An entry with any other tag
 * has no handler and is stored undecoded unless `EventLogServerAuthorization` refuses it, as
 * `layerSyncAuthorization` does. The order of its entries is the order in which writes reach
 * `Storage`, one at a time.
 */
export const layerSyncServer = (def: AnyDefinition) => {
  const validation = EventLog.group(
    syncGroup(def),
    (handlers) =>
      handlers
        .handle(PROPOSAL, () => Effect.void)
        .handle(AUTO_PROPOSAL, () => Effect.void)
        .handle(JOINED, () => Effect.void)
        .handle(LEASE, () => Effect.void)
        .handle(SNAPSHOT, () => Effect.die("a Snapshot is written by the cut only"))
  )
  return Layer.mergeAll(EventLogServerUnencrypted.layerRpcHandlers, validation, layerSyncHeadHandlers).pipe(
    Layer.provide(EventLogServerUnencrypted.layerStoreMappingStatic({ storeId: syncStoreId(def) })),
    Layer.provide(EventLog.layerRegistry)
  )
}
