import { Effect, Layer, PubSub, Schema, Semaphore, Stream } from "effect"
import { Hex, SchemaBinary } from "effect/encoding"
import { EventJournal, EventLogServerUnencrypted } from "effect/eventlog"
import { KeyValueStore } from "effect/persistence"
import type { AnyDefinition } from "./Definition.ts"
import { LogId, syncStoreId } from "./Sync.ts"

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
  readonly segment: (index: number) => string
}

const keysOf = (def: AnyDefinition): Keys => ({
  id: `${def.name}/log/id`,
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

/** Every stored entry in sequence order: segments are numbered from 0 and the first absent one ends the log. */
const loadJournal = (store: KeyValueStore.KeyValueStore, keys: Keys) =>
  Effect.gen(function*() {
    const journal: Array<EventJournal.RemoteEntry> = []
    let index = 0
    let bytes = yield* store.getUint8Array(keys.segment(index))
    while (bytes !== undefined) {
      const segment = yield* decodeSegment(bytes)
      for (const entry of segment) journal.push(remoteEntry(journal.length + 1, entry))
      index += 1
      bytes = yield* store.getUint8Array(keys.segment(index))
    }
    return journal
  })

/**
 * The event-log server's `Storage` for one definition's log, kept in a `KeyValueStore`: the log's
 * id under `<name>/log/id` and its entries, `SEGMENT_SIZE` to a key, under `<name>/log/<n>`. It is
 * the same service `EventLogServerUnencrypted.layerStorageMemory` provides, so a server runs over
 * either, and a log that is persisted survives the server's restart with its entries, their
 * sequences and its id.
 *
 * - Building the layer reads the whole log into memory, as the in-memory storage holds it, and fails
 *   with `SchemaError` when a stored value does not decode, or `KeyValueStoreError`.
 * - An entry is stored before it is published or counted: a `write` returns, and `changes`
 *   delivers, only entries the store has accepted, so a subscriber never reads one a restart would
 *   lose. A store that fails the write fails the entry as a defect, which the event-log server
 *   answers to its writer as a persistence failure and the log in the process as a defect of `append`.
 * - The store decides what a crash leaves (`layerAtomicFileStore` in the example writes a segment
 *   atomically and syncs it): a segment is either the previous content or the new one.
 * - The log serves the one store id of `syncStoreId(def)`; any other is a defect.
 * - Session authentication bindings (a public key's first signing key) stay in memory: an instance
 *   generates a new identity each time it starts, so a persisted binding would never be read again.
 */
export const layerSyncStorage = (def: AnyDefinition) =>
  Layer.effect(
    EventLogServerUnencrypted.Storage,
    Effect.gen(function*() {
      const store = yield* KeyValueStore.KeyValueStore
      const keys = keysOf(def)
      const storeId = syncStoreId(def)
      const remoteId = yield* loadRemoteId(store, keys)
      const journal = yield* loadJournal(store, keys)
      const known = new Set(journal.map((remote) => remote.entry.idString))
      const published = yield* Effect.acquireRelease(PubSub.unbounded<EventJournal.RemoteEntry>(), PubSub.shutdown)
      const transaction = yield* Semaphore.make(1)
      const bindings = new Map<string, Uint8Array<ArrayBuffer>>()

      const own = <A, R>(requested: typeof storeId, effect: Effect.Effect<A, never, R>) =>
        requested === storeId ? effect : Effect.die(`store "${requested}" is not this log's "${storeId}"`)

      const append = (entry: EventJournal.Entry) =>
        Effect.gen(function*() {
          const sequence = journal.length + 1
          const index = Math.floor((sequence - 1) / SEGMENT_SIZE)
          const sameSegment = journal.slice(index * SEGMENT_SIZE).map((remote) => remote.entry)
          yield* store.set(keys.segment(index), yield* encodeSegment([...sameSegment, entry]))
          const committed = remoteEntry(sequence, entry)
          journal.push(committed)
          known.add(entry.idString)
          return committed
        }).pipe(Effect.orDie)

      const write: Storage["write"] = (requested, entries) =>
        own(
          requested,
          Effect.gen(function*() {
            if (entries.some((entry) => known.has(entry.idString))) return yield* Effect.die("Duplicate entries")
            const committed = yield* Effect.forEach(entries, append)
            yield* PubSub.publishAll(published, committed)
            return committed
          })
        )

      const entriesAfter: Storage["entriesAfter"] = (requested, entry) =>
        own(
          requested,
          Effect.sync(() =>
            journal.filter((remote) => EventJournal.Entry.Order(remote.entry, entry) >= 0).map((remote) => remote.entry)
          )
        )

      const changes: Storage["changes"] = (options) =>
        Stream.unwrap(
          own(
            options.storeId,
            Effect.gen(function*() {
              const subscription = yield* PubSub.subscribe(published)
              const backlog = yield* EventLogServerUnencrypted.compactBacklog({
                remoteEntries: journal.filter((remote) => remote.remoteSequence >= options.startSequence),
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

      return EventLogServerUnencrypted.Storage.of({
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
    })
  )
