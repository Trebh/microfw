import { Cause, Context, Effect, Ref, Schema } from "effect"
import { EventJournal } from "effect/eventlog"
import type { KeyValueStore } from "effect/persistence"
import type { AnyDefinition, ModelOf } from "./Definition.ts"
import type { SyncCheckpoint } from "./Sync.ts"
import { LeaseState } from "./SyncLease.ts"

/** The event of the entry that stands for every entry before it. */
export const SNAPSHOT = "Snapshot"

/**
 * The payload of a `Snapshot` entry: the log's state after `through`, the model and the lease the
 * entries up to there give, and the ids of the last entries it stands for, so that a writer whose
 * entry was cut away before it heard it can tell (`applied`).
 */
export const snapshotPayload = <D extends AnyDefinition>(def: D) => {
  const model: Schema.Codec<ModelOf<D>, unknown> = def.model
  return Schema.Struct({
    through: Schema.Natural.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
    model,
    lease: LeaseState,
    applied: Schema.Array(EventJournal.EntryId)
  })
}

/** What a `Snapshot` entry's payload decodes to. */
export interface Snapshot<D extends AnyDefinition> {
  readonly through: number
  readonly model: ModelOf<D>
  readonly lease: LeaseState
  readonly applied: ReadonlyArray<EventJournal.EntryId>
}

/**
 * What the host's applier asks its storage to cut away. `model` is `unknown`: the storage does not
 * know the definition's types and encodes the model with the definition's schema.
 */
export interface CutRequest {
  readonly through: number
  readonly model: unknown
  readonly lease: LeaseState
  /** How many of the newest cut entries the snapshot keeps the ids of. */
  readonly retain: number
}

export type SyncCutFailure = KeyValueStore.KeyValueStoreError | Schema.SchemaError

/** What a log offers to the process that owns it. */
export interface LogCut {
  /** The sequence of the log's snapshot, 0 while it has never been cut. */
  readonly base: Effect.Effect<number>
  /**
   * Replaces entries `1..through` by a snapshot at `through`. A `through` at or before `base` does
   * nothing; one past the log's newest entry is a defect.
   */
  readonly cut: (request: CutRequest) => Effect.Effect<void, SyncCutFailure>
}

/** Provided by `layerSyncStorage` beside `Storage`. A memory host (`layerSyncStorageMemory`) provides none. */
export class SyncStorageCut extends Context.Service<SyncStorageCut, LogCut>()("@mufw/core/SyncStorageCut") {}

export interface SyncCutOptions {
  /** Cut when the sequence just applied is at least this many entries past the log's last cut. */
  readonly every: number
}

/** `SyncOptions.cut` was given over a log that has no way to cut: only the host over `layerSyncStorage` has one. */
export class SyncCutUnsupported extends Schema.TaggedError<SyncCutUnsupported>()("SyncCutUnsupported", {
  message: Schema.String
}) {}

/**
 * The snapshot an instance reads cannot be applied: it does not decode with this definition's model
 * schema, or its `through` is not the sequence it was delivered at. The instance stops, as for a
 * foreign log: skipping it would leave a model no other instance has.
 */
export class SyncSnapshotUnreadable extends Schema.TaggedError<SyncSnapshotUnreadable>()("SyncSnapshotUnreadable", {
  sequence: Schema.Natural,
  message: Schema.String
}) {}

/** The text of an entry id, as `Entry.idString` gives it for an entry carrying that id. */
export const idStringOf = (id: EventJournal.EntryId) =>
  new EventJournal.Entry({ id, event: SNAPSHOT, primaryKey: "", payload: new Uint8Array() }, { disableChecks: true })
    .idString

/**
 * The rule that decides when the host cuts: once the sequence just applied is at least `every`
 * past the log's last cut (`base`, read once from the log and moved to the `through` of each cut
 * attempted, so a failed cut is tried again `every` entries later, not at every entry). At most one
 * cut runs at a time, in a fiber of the layer's scope: a storage that is slow or fails costs the
 * applier nothing, and a failure is logged.
 */
export const makeCutter = <D extends AnyDefinition>(log: LogCut, options: SyncCutOptions) =>
  Effect.gen(function*() {
    const attempted = yield* Ref.make(yield* log.base)
    const running = yield* Ref.make(false)
    const scope = yield* Effect.scope
    const cutAt = (checkpoint: SyncCheckpoint<D>) =>
      log.cut({
        through: checkpoint.sequence,
        model: checkpoint.model,
        lease: checkpoint.lease,
        retain: options.every
      }).pipe(
        Effect.catch((error) => Effect.logWarning("log not cut", Cause.fail(error))),
        Effect.catchDefect((defect) => Effect.logWarning("log not cut", Cause.die(defect))),
        Effect.ensuring(Ref.set(running, false))
      )
    const isDue = (sequence: number) =>
      Effect.map(Ref.get(attempted), (base) => sequence > base && sequence - base >= options.every)
    return (checkpoint: SyncCheckpoint<D>) =>
      Effect.gen(function*() {
        if (!(yield* isDue(checkpoint.sequence))) return
        if (yield* Ref.getAndSet(running, true)) return
        yield* Ref.set(attempted, checkpoint.sequence)
        yield* Effect.asVoid(Effect.forkIn(cutAt(checkpoint), scope))
      })
  })
