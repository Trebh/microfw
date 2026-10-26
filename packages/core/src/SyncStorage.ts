import { Cause, Clock, Context, Effect, Layer, PubSub, Ref, Schema, Semaphore, Stream } from "effect"
import { Hex, SchemaBinary } from "effect/encoding"
import { EventJournal, EventLogServerUnencrypted } from "effect/eventlog"
import { KeyValueStore } from "effect/persistence"
import type { AnyDefinition } from "./Definition.ts"
import { LogId, syncStoreId } from "./Sync.ts"
import { SyncHead } from "./SyncHead.ts"
import {
  type CutRequest,
  type LogCut,
  SNAPSHOT,
  snapshotPayload,
  type SyncCutFailure,
  SyncStorageCut
} from "./SyncSnapshot.ts"

/** Entries per stored key: appending rewrites one segment, at most this many entries, not the whole log. */
const SEGMENT_SIZE = 256

const SegmentCodec = SchemaBinary.toCodec(Schema.Array(EventJournal.Entry))
const encodeSegment = Schema.encodeEffect(SegmentCodec)
const decodeSegment = Schema.decodeUnknownEffect(SegmentCodec)
const decodeRemoteId = Schema.decodeUnknownEffect(EventJournal.RemoteId)
const decodeLogId = Schema.decodeUnknownEffect(LogId)

type Storage = EventLogServerUnencrypted.Storage["Service"]

interface Keys {
  readonly id: string
  readonly start: string
  readonly segment: (index: number) => string
}

const keysOf = (def: AnyDefinition): Keys => ({
  id: `${def.name}/log/id`,
  start: `${def.name}/log/start`,
  segment: (index) => `${def.name}/log/${index}`
})

/**
 * The stored id, or a new random one stored first: the log keeps its identity for as long as its
 * keys exist. A stored id that is not 16 bytes is not an id: it fails as a `SchemaError`.
 */
const loadRemoteId = (store: KeyValueStore.KeyValueStore, keys: Keys) =>
  Effect.gen(function*() {
    const stored = yield* store.getUint8Array(keys.id)
    if (stored !== undefined) {
      const remoteId = yield* decodeRemoteId(stored)
      yield* decodeLogId(Hex.encode(remoteId))
      return remoteId
    }
    const created = yield* Effect.sync(EventJournal.makeRemoteIdUnsafe)
    yield* store.set(keys.id, created)
    return created
  })

const remoteEntry = (remoteSequence: number, entry: EventJournal.Entry) =>
  new EventJournal.RemoteEntry({ remoteSequence, entry }, { disableChecks: true })

/** One stored segment: the index of its key and the entries it holds. */
interface Segment {
  readonly index: number
  readonly entries: ReadonlyArray<EventJournal.Entry>
}

/** The segment a sequence is stored in: sequences `(n * SEGMENT_SIZE, (n + 1) * SEGMENT_SIZE]` go to segment `n`. */
const segmentIndexOf = (sequence: number) => Math.floor((sequence - 1) / SEGMENT_SIZE)

const lastOf = (journal: ReadonlyArray<EventJournal.RemoteEntry>) => journal.at(-1)?.remoteSequence ?? 0

/** The sequence of the snapshot a log starts with, 0 for a log never cut. */
const baseOf = (journal: ReadonlyArray<EventJournal.RemoteEntry>) => {
  const first = journal[0]
  return first !== undefined && first.entry.event === SNAPSHOT ? first.remoteSequence : 0
}

/** What stands in `entriesAfter` for an entry a cut dropped: its id under an event no real entry has. */
const stubOf = (id: EventJournal.EntryId) =>
  new EventJournal.Entry({ id, event: SNAPSHOT, primaryKey: "", payload: new Uint8Array() }, { disableChecks: true })

/** What the process holds of the log: the retained entries, the ids a snapshot stands for and every id a write must refuse. */
interface Held {
  readonly journal: Array<EventJournal.RemoteEntry>
  readonly applied: ReadonlyArray<EventJournal.EntryId>
  readonly stubs: ReadonlyArray<EventJournal.Entry>
  readonly known: Set<string>
}

const holding = (journal: Array<EventJournal.RemoteEntry>, applied: ReadonlyArray<EventJournal.EntryId>): Held => {
  const stubs = applied.map(stubOf).sort(EventJournal.Entry.Order)
  const known = new Set([...journal.map((remote) => remote.entry.idString), ...stubs.map((stub) => stub.idString)])
  return { journal, applied, stubs, known }
}

const decodeStart = Schema.decodeUnknownEffect(
  Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))
)

const decodeSnapshotOf = (def: AnyDefinition) => Schema.decodeUnknownEffect(SchemaBinary.toCodec(snapshotPayload(def)))

/** The index of the first live segment a cut stored, 0 while the log has never been cut. */
const loadStart = (store: KeyValueStore.KeyValueStore, keys: Keys) =>
  Effect.gen(function*() {
    const stored = yield* store.get(keys.start)
    return stored === undefined ? 0 : yield* decodeStart(stored)
  })

/** The segments from `start` on: the first absent key ends them. */
const readSegments = (store: KeyValueStore.KeyValueStore, keys: Keys, start: number) =>
  Effect.gen(function*() {
    const segments: Array<Segment> = []
    let bytes = yield* store.getUint8Array(keys.segment(start))
    while (bytes !== undefined) {
      segments.push({ index: start + segments.length, entries: yield* decodeSegment(bytes) })
      bytes = yield* store.getUint8Array(keys.segment(start + segments.length))
    }
    return segments
  })

/** The newest snapshot a stored segment begins with: where it is in `segments`, what it stands for and the ids it keeps. */
const newestSnapshot = (segments: ReadonlyArray<Segment>, def: AnyDefinition) =>
  Effect.gen(function*() {
    const position = segments.findLastIndex((segment) => segment.entries[0]?.event === SNAPSHOT)
    const first = segments[position]?.entries[0]
    if (first === undefined) return undefined
    const { applied, through } = yield* decodeSnapshotOf(def)(first.payload)
    return { position, through, applied }
  })

const numbered = (segments: ReadonlyArray<Segment>, from: number) =>
  segments.flatMap((segment) => segment.entries).map((entry, offset) => remoteEntry(from + offset, entry))

/** What the store holds of a log: its entries numbered, the ids its snapshot keeps, and how far a cut's tidying got. */
interface LoadedLog {
  readonly journal: Array<EventJournal.RemoteEntry>
  readonly applied: ReadonlyArray<EventJournal.EntryId>
  /** The index `<name>/log/start` names. */
  readonly start: number
  /** The index of the segment the log begins in. */
  readonly first: number
  /** The indexes of the segments a newer snapshot segment replaced and a cut did not remove. */
  readonly stale: ReadonlyArray<number>
}

/**
 * Every stored entry in sequence order. A log never cut starts at sequence `start * SEGMENT_SIZE + 1`;
 * a log whose segment begins with a `Snapshot` starts at the snapshot's `through`, and when a cut
 * stopped before it removed the older segments, the newest such segment wins and the ones before it
 * are `stale`.
 */
const loadJournal = (store: KeyValueStore.KeyValueStore, keys: Keys, def: AnyDefinition) =>
  Effect.gen(function*() {
    const start = yield* loadStart(store, keys)
    const segments = yield* readSegments(store, keys, start)
    const snapshot = yield* newestSnapshot(segments, def)
    const position = snapshot?.position ?? 0
    const live = segments.slice(position)
    const loaded: LoadedLog = {
      journal: numbered(live, snapshot?.through ?? start * SEGMENT_SIZE + 1),
      applied: snapshot?.applied ?? [],
      start,
      first: live[0]?.index ?? start,
      stale: segments.slice(0, position).map((segment) => segment.index)
    }
    return loaded
  })

const warn = (what: string) => (error: unknown) => Effect.logWarning(what, Cause.fail(error))

/**
 * Points `start` at `first`, then removes the `stale` segments before it, oldest first. The start
 * is written first: a log whose start is behind a removed segment would read as empty. A failure
 * is logged: the segment that carries the snapshot is already stored and the loader tolerates what
 * is left.
 */
const retire = (store: KeyValueStore.KeyValueStore, keys: Keys, first: number, stale: ReadonlyArray<number>) =>
  Effect.gen(function*() {
    if (stale.length === 0) return
    yield* store.set(keys.start, String(first))
    yield* Effect.forEach(stale, (index) => store.remove(keys.segment(index)), { discard: true })
  }).pipe(Effect.catch(warn("stale log segments not removed")))

/** Removes what an interrupted removal left below `start`, nearest first, until a key is absent. */
const removeBelow = (store: KeyValueStore.KeyValueStore, keys: Keys, start: number) =>
  Effect.gen(function*() {
    let index = start - 1
    while (index >= 0 && (yield* store.has(keys.segment(index)))) {
      yield* store.remove(keys.segment(index))
      index -= 1
    }
  }).pipe(Effect.catch(warn("stale log segments not removed")))

/** Finishes a cut that stopped before it removed the segments it replaced; writes nothing for a log that is tidy. */
const tidy = (store: KeyValueStore.KeyValueStore, keys: Keys, loaded: LoadedLog) =>
  retire(store, keys, loaded.first, loaded.stale).pipe(Effect.andThen(removeBelow(store, keys, loaded.start)))

/** The entries stored in the segment `sequence` goes to, before it. */
const storedBefore = (journal: ReadonlyArray<EventJournal.RemoteEntry>, sequence: number) => {
  const firstSequence = journal[0]?.remoteSequence ?? 1
  const lowest = Math.max(segmentIndexOf(sequence) * SEGMENT_SIZE + 1, firstSequence)
  return journal.slice(lowest - firstSequence).map((remote) => remote.entry)
}

/** The ids a snapshot at `request.through` keeps: the newest `request.retain` of the ids it stands for. */
const appliedAfter = (held: Held, request: CutRequest) => {
  const covered = held.journal.filter((remote) =>
    remote.remoteSequence <= request.through && remote.entry.event !== SNAPSHOT
  )
  const ids = [...held.applied, ...covered.map((remote) => remote.entry.id)]
  return ids.slice(Math.max(0, ids.length - request.retain))
}

interface Memory {
  held: Held
}

interface CutScope {
  readonly store: KeyValueStore.KeyValueStore
  readonly keys: Keys
  readonly def: AnyDefinition
  readonly memory: Memory
  readonly transaction: Semaphore.Semaphore
}

/**
 * The cut of the log in `scope.memory`. It runs under the storage's transaction, so no write is in
 * flight, and stores the snapshot's segment in one write before anything else changes: a segment
 * is the previous content or the new one.
 */
const makeLogCut = (scope: CutScope): LogCut => {
  const { keys, memory, store } = scope
  const encodePayload = Schema.encodeUnknownEffect(SchemaBinary.toCodec(snapshotPayload(scope.def)))

  const snapshotEntry = (request: CutRequest, applied: ReadonlyArray<EventJournal.EntryId>) =>
    Effect.gen(function*() {
      const payload = yield* encodePayload({
        through: request.through,
        model: request.model,
        lease: request.lease,
        applied
      })
      const now = yield* Clock.currentTimeMillis
      const id = EventJournal.makeEntryIdUnsafe({ msecs: now })
      // The codec returns a view of a buffer it reuses; the entry outlives the next encoding.
      const owned = payload.slice()
      const fields = { id, event: SNAPSHOT, primaryKey: scope.def.name, payload: owned }
      return new EventJournal.Entry(fields, { disableChecks: true })
    })

  const writeSegment = (index: number, kept: ReadonlyArray<EventJournal.RemoteEntry>) => {
    const inSegment = kept.filter((remote) => remote.remoteSequence <= (index + 1) * SEGMENT_SIZE)
    return encodeSegment(inSegment.map((remote) => remote.entry)).pipe(
      Effect.flatMap((bytes) => store.set(keys.segment(index), bytes))
    )
  }

  const commit = (request: CutRequest) =>
    Effect.gen(function*() {
      const { journal } = memory.held
      const applied = appliedAfter(memory.held, request)
      const snapshot = remoteEntry(request.through, yield* snapshotEntry(request, applied))
      const kept = [snapshot, ...journal.filter((remote) => remote.remoteSequence > request.through)]
      const index = segmentIndexOf(request.through)
      yield* writeSegment(index, kept)
      const oldStart = segmentIndexOf(journal[0]?.remoteSequence ?? 1)
      const replaced = Array.from({ length: index - oldStart }, (_, offset) => oldStart + offset)
      yield* retire(store, keys, index, replaced)
      memory.held = holding(kept, applied)
    })

  const cutAt = (request: CutRequest): Effect.Effect<void, SyncCutFailure> => {
    const { journal } = memory.held
    if (request.through <= baseOf(journal)) return Effect.void
    if (request.through > lastOf(journal)) {
      return Effect.die(`cut through ${request.through} is past the log's newest entry ${lastOf(journal)}`)
    }
    return commit(request)
  }

  return {
    base: Effect.sync(() => baseOf(memory.held.journal)),
    cut: (request) => scope.transaction.withPermits(1)(Effect.suspend(() => cutAt(request)))
  }
}

/**
 * The event-log server's `Storage` for one definition's log, kept in a `KeyValueStore`: the log's
 * id under `<name>/log/id` and its entries, `SEGMENT_SIZE` to a key, under `<name>/log/<n>`. It
 * provides the `SyncHead` of the log and its `SyncStorageCut` beside the `Storage`, and a log that
 * is persisted survives the server's restart with its entries, their sequences and its id.
 *
 * - Building the layer reads the whole log into memory, as the in-memory storage holds it, and fails
 *   with `SchemaError` when a stored value does not decode, or `KeyValueStoreError`.
 * - An entry is stored before it is published or counted: a `write` returns, and `changes`
 *   delivers, only entries the store has accepted, so a subscriber never reads one a restart would
 *   lose. A store that fails the write fails the entry as a defect, which the event-log server
 *   answers to its writer as a persistence failure and the log in the process as a defect of `append`.
 * - The store decides what a crash leaves (`layerAtomicFileStore` in the example writes a segment
 *   atomically and syncs it): a segment is either the previous content or the new one.
 * - `SyncHead.last` is the sequence of the newest stored entry. Sequences are dense from the log's
 *   first retained one, and an entry is counted before it is published, so no subscriber has seen an
 *   entry the head does not count.
 * - `SyncStorageCut` replaces the entries up to `through` by one `Snapshot` entry stored at sequence
 *   `through`, so no sequence changes meaning. The snapshot is the first entry of the segment that
 *   holds `through`: that single segment write commits the cut. `<name>/log/start` then names the
 *   first live segment and the older segments are removed. A failure of either is logged and the
 *   cut stands; the next build finishes it (the newest segment that begins with a `Snapshot` wins
 *   over older ones, and segments below `start` are removed). A log stored before cuts existed
 *   loads as it was and nothing is written.
 * - The snapshot keeps the ids of the last `retain` entries it stands for, and `entriesAfter` answers
 *   for each of them with an entry of its own id, so the event-log server drops a writer's resend of
 *   one as the duplicate it is, and `write` refuses it. An entry resent after more than `retain`
 *   entries were cut in between is stored again.
 * - A `Snapshot` is written by the cut only: `write` dies on one.
 * - The log serves the one store id of `syncStoreId(def)`; any other is a defect.
 * - Session authentication bindings (a public key's first signing key) stay in memory: an instance
 *   generates a new identity each time it starts, so a persisted binding would never be read again.
 */
export const layerSyncStorage = (def: AnyDefinition) =>
  Layer.effectContext(
    Effect.gen(function*() {
      const store = yield* KeyValueStore.KeyValueStore
      const keys = keysOf(def)
      const storeId = syncStoreId(def)
      const remoteId = yield* loadRemoteId(store, keys)
      const loaded = yield* loadJournal(store, keys, def)
      yield* tidy(store, keys, loaded)
      const memory: Memory = { held: holding(loaded.journal, loaded.applied) }
      const published = yield* Effect.acquireRelease(PubSub.unbounded<EventJournal.RemoteEntry>(), PubSub.shutdown)
      const transaction = yield* Semaphore.make(1)
      const bindings = new Map<string, Uint8Array<ArrayBuffer>>()

      const own = <A, R>(requested: typeof storeId, effect: Effect.Effect<A, never, R>) =>
        requested === storeId ? effect : Effect.die(`store "${requested}" is not this log's "${storeId}"`)

      const append = (entry: EventJournal.Entry) =>
        Effect.gen(function*() {
          const { journal, known } = memory.held
          const sequence = lastOf(journal) + 1
          const sameSegment = storedBefore(journal, sequence)
          yield* store.set(keys.segment(segmentIndexOf(sequence)), yield* encodeSegment([...sameSegment, entry]))
          const committed = remoteEntry(sequence, entry)
          journal.push(committed)
          known.add(entry.idString)
          return committed
        }).pipe(Effect.orDie)

      const write: Storage["write"] = (requested, entries) =>
        own(
          requested,
          Effect.gen(function*() {
            if (entries.some((entry) => entry.event === SNAPSHOT)) {
              return yield* Effect.die("a Snapshot is written by the cut only")
            }
            if (entries.some((entry) => memory.held.known.has(entry.idString))) {
              return yield* Effect.die("Duplicate entries")
            }
            const committed = yield* Effect.forEach(entries, append)
            yield* PubSub.publishAll(published, committed)
            return committed
          })
        )

      const entriesAfter: Storage["entriesAfter"] = (requested, entry) =>
        own(
          requested,
          Effect.sync(() => {
            const isAfter = (candidate: EventJournal.Entry) => EventJournal.Entry.Order(candidate, entry) >= 0
            const retained = memory.held.journal.map((remote) => remote.entry)
            return [...memory.held.stubs.filter(isAfter), ...retained.filter(isAfter)]
          })
        )

      const changes: Storage["changes"] = (options) =>
        Stream.unwrap(
          own(
            options.storeId,
            Effect.gen(function*() {
              const subscription = yield* PubSub.subscribe(published)
              const backlog = yield* EventLogServerUnencrypted.compactBacklog({
                remoteEntries: memory.held.journal.filter((remote) => remote.remoteSequence >= options.startSequence),
                compactors: options.compactors
              })
              const replayedUpTo = backlog.at(-1)?.remoteSequence ?? options.startSequence - 1
              const live = Stream.fromSubscription(subscription).pipe(
                Stream.filter((remote) => remote.remoteSequence > replayedUpTo)
              )
              return Stream.concat(Stream.fromArray(backlog), live)
            })
          )
        )

      const storage = EventLogServerUnencrypted.Storage.of({
        getId: Effect.succeed(remoteId),
        getOrCreateSessionAuthBinding: (publicKey, signingPublicKey) =>
          Effect.sync(() => {
            const existing = bindings.get(publicKey)
            if (existing !== undefined) return existing
            bindings.set(publicKey, signingPublicKey)
            return signingPublicKey
          }),
        entriesAfter,
        write,
        changes,
        withTransaction: transaction.withPermits(1)
      })
      const head = SyncHead.of({ last: Effect.sync(() => lastOf(memory.held.journal)) })
      const logCut = makeLogCut({ store, keys, def, memory, transaction })
      return Context.make(EventLogServerUnencrypted.Storage, storage).pipe(
        Context.add(SyncHead, head),
        Context.add(SyncStorageCut, logCut)
      )
    })
  )

/**
 * Effect's in-memory `Storage` for one definition's log, and the `SyncHead` that `Storage` cannot
 * give: the log is gone with the process. The head is the sequence of the newest entry a `write` to
 * `syncStoreId(def)` committed, read under the storage's transaction, so a read that races a write
 * waits until the write has been counted. Every writer in this package holds the transaction (the
 * event-log server's write handler and `layerSyncLogStorage.append`); a writer that does not may be
 * counted a moment after a subscriber has read its entry.
 */
export const layerSyncStorageMemory = (def: AnyDefinition) =>
  Layer.effectContext(
    Effect.gen(function*() {
      const storeId = syncStoreId(def)
      const inner = yield* EventLogServerUnencrypted.makeStorageMemory
      const newest = yield* Ref.make(0)
      const countNewest = (committed: ReadonlyArray<EventJournal.RemoteEntry>) =>
        Ref.update(newest, (previous) => committed.at(-1)?.remoteSequence ?? previous)
      const write: Storage["write"] = (requested, entries) =>
        inner.write(requested, entries).pipe(
          Effect.tap((committed) => requested === storeId ? countNewest(committed) : Effect.void)
        )
      const storage = EventLogServerUnencrypted.Storage.of({ ...inner, write })
      const head = SyncHead.of({ last: inner.withTransaction(Ref.get(newest)) })
      return Context.make(EventLogServerUnencrypted.Storage, storage).pipe(Context.add(SyncHead, head))
    })
  )
