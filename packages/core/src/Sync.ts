import { Cause, Clock, Context, Deferred, Effect, Layer, Ref, Schedule, Schema, Stream } from "effect"
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
import type { AnyDefinition, ProposalOf } from "./Definition.ts"
import { layerActionRunnerLocal, layerActionsDrain, layerIntentBus, layerModelLocal } from "./Layers.ts"
import { makePorts, type ModelPortShape, type Ports } from "./Ports.ts"

const PROPOSAL = "Proposal"
const JOINED = "Joined"

/** One store per definition, so two definitions never share a log. */
export const syncStoreId = (def: AnyDefinition) => EventLogMessage.StoreId.make(def.name)

const proposalEvent = <D extends AnyDefinition>(def: D) => {
  const payload: Schema.Codec<ProposalOf<D>, unknown> = def.proposal
  return Event.make({ tag: PROPOSAL, primaryKey: () => def.name, payload })
}

/**
 * The events a definition's log holds. `Proposal` carries a proposal, encoded with the
 * definition's `proposal` schema. `Joined` carries nothing: an instance writes one to learn when
 * it has replayed everything the log held before it.
 */
export const syncGroup = <D extends AnyDefinition>(def: D) => {
  const payload: Schema.Codec<ProposalOf<D>, unknown> = def.proposal
  return EventGroup.empty
    .add({ tag: PROPOSAL, primaryKey: () => def.name, payload })
    .add({ tag: JOINED, primaryKey: () => def.name })
}

/**
 * The sequencer of a synced loop: an ordered, append-only log shared by every instance. `entries`
 * delivers entries with a sequence of at least `from`, in sequence order, the instance's own
 * included, then follows live ones. The order is the log's alone: every instance sees the same
 * sequence of entries.
 */
export class SyncLog extends Context.Service<SyncLog, {
  readonly append: (entry: EventJournal.Entry) => Effect.Effect<void, EventLogRemote.EventLogRemoteError>
  readonly entries: (
    from: number
  ) => Stream.Stream<EventJournal.RemoteEntry, EventLogRemote.EventLogRemoteError>
}>()("@mufw/core/SyncLog") {}

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
  readonly joinedEntry: Effect.Effect<EventJournal.Entry>
  readonly decodeProposal: (entry: EventJournal.Entry) => Effect.Effect<ProposalOf<D>, Schema.SchemaError>
}

const makeWire = <D extends AnyDefinition>(def: D): Wire<D> => {
  const proposal = proposalEvent(def)
  const joined = Event.make({ tag: JOINED, primaryKey: () => def.name })
  const encodeProposal = Schema.encodeUnknownEffect(proposal.payloadSchemaBinary)
  const encodeJoined = Schema.encodeUnknownEffect(joined.payloadSchemaBinary)
  const decodeProposal = Schema.decodeUnknownEffect(proposal.payloadSchemaBinary)
  return {
    proposalEntry: (value) => encodeEntry(PROPOSAL, def.name, encodeProposal(value)),
    joinedEntry: encodeEntry(JOINED, def.name, encodeJoined(undefined)),
    decodeProposal: (entry) => decodeProposal(entry.payload)
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

/**
 * Applies one log entry through the replica's `present`, in the order the log delivers them.
 * A proposal that does not decode, or whose acceptor dies, is logged and skipped: every instance
 * reads the same entry and skips it alike, so they still agree.
 */
const makeApply = <D extends AnyDefinition>(
  wire: Wire<D>,
  replica: ModelPortShape<D>,
  waiting: Waiting,
  next: Ref.Ref<number>
) => {
  const applyProposal = (entry: EventJournal.Entry) =>
    wire.decodeProposal(entry).pipe(
      Effect.flatMap((proposal) => replica.present(proposal)),
      Effect.catch((error) => Effect.logError("log entry not decoded", entry.idString, Cause.fail(error))),
      Effect.catchDefect((defect) => Effect.logError("log entry not applied", entry.idString, Cause.die(defect)))
    )
  const acknowledge = (id: string) => {
    const waiter = waiting.get(id)
    return waiter === undefined ? Effect.void : Deferred.succeed(waiter, undefined)
  }
  return (remote: EventJournal.RemoteEntry) =>
    Effect.gen(function*() {
      if (remote.entry.event === PROPOSAL) yield* applyProposal(remote.entry)
      yield* Ref.set(next, remote.remoteSequence + 1)
      yield* acknowledge(remote.entry.idString)
    })
}

/** From the next unapplied sequence, again after every loss of the log, for as long as the scope lives. */
const followLog = (log: SyncLog["Service"], next: Ref.Ref<number>) =>
  Stream.unwrap(Effect.map(Ref.get(next), log.entries)).pipe(
    Stream.tapError((error) => Effect.logWarning("sync log lost, subscribing again", Cause.fail(error))),
    Stream.retry(Schedule.spaced("1 second"))
  )

/**
 * Starts the applier and returns once it has replayed every entry the log held when this was
 * called: a `Joined` entry is appended and awaited, and entries are applied in sequence order, so
 * everything before it has been applied by then. Fails when the log refuses the append.
 */
const makeSequencer = <D extends AnyDefinition>(def: D, log: SyncLog["Service"], replica: ModelPortShape<D>) =>
  Effect.gen(function*() {
    const wire = makeWire(def)
    const waiting: Waiting = new Map()
    const next = yield* Ref.make(0)
    const apply = makeApply(wire, replica, waiting, next)
    yield* Effect.forkScoped(Stream.runForEach(followLog(log, next), apply))
    yield* appendAndAwait(log, waiting, yield* wire.joinedEntry)
    const present = (proposal: ProposalOf<D>) =>
      wire.proposalEntry(proposal).pipe(
        Effect.flatMap((entry) => appendAndAwait(log, waiting, entry)),
        Effect.orDie
      )
    return { present }
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
 * - Catch-up: the log is replayed from its first entry, and the layer is built once the instance
 *   has applied everything the log held when it joined. A log that restarts empty is not
 *   detected: restart every instance with it.
 * - `nap` runs on every instance, so exactly one instance should run automatic actions
 *   (`AutoActions` true) and the others none: otherwise each emits the same tick.
 * - `HistoryPort.travelTo` moves one instance's model away from the log; do not serve it. Until
 *   a travel, instances hold records with the same `seq` and model for each applied proposal;
 *   only `at`, the local commit time, differs.
 * - A lost connection is not a failure of `present`: it sends the same entry again every second
 *   until the log has it, and returns as soon as the entry has been applied, so it waits for as
 *   long as the log is out of reach. It dies only when the log refuses the entry.
 *
 * Starts from `def.initial`; a model restored from elsewhere would not be the log's.
 */
export const layerLoopSynced = <D extends AnyDefinition, R = never>(def: D, ports: Ports<D, R>) => {
  // The replica's ports are the same services under other keys; `makePorts` reads only the name.
  const replica = makePorts<D, R>({ ...def, name: `${def.name}/replica` })
  const replicaBus = Layer.effect(
    replica.IntentBus,
    Effect.gen(function*() {
      return yield* ports.IntentBus
    })
  )
  const replicaModel = layerModelLocal(def, replica).pipe(Layer.provide(replicaBus))
  const sequenced = Layer.effectContext(
    Effect.gen(function*() {
      const log = yield* SyncLog
      const model = yield* replica.ModelPort
      const history = yield* replica.HistoryPort
      const sequencer = yield* makeSequencer(def, log, model)
      const port: ModelPortShape<D> = { present: sequencer.present, representations: model.representations }
      return Context.make(ports.ModelPort, port).pipe(Context.add(ports.HistoryPort, history))
    })
  ).pipe(Layer.provide(replicaModel))
  return layerActionsDrain(def, ports).pipe(
    Layer.provideMerge(Layer.merge(sequenced, layerActionRunnerLocal(def, ports))),
    Layer.provideMerge(layerIntentBus(def, ports))
  )
}

/**
 * The log of a server's own process: appends to and reads the server's `Storage` directly, in
 * the same transaction and the same sequence as the entries clients write over RPC.
 */
export const layerSyncLogStorage = (def: AnyDefinition) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const storage = yield* EventLogServerUnencrypted.Storage
      const storeId = syncStoreId(def)
      return SyncLog.of({
        append: (entry) => Effect.asVoid(storage.withTransaction(storage.write(storeId, [entry]))),
        entries: (from) => storage.changes({ storeId, startSequence: from, compactors: new Map() })
      })
    })
  )

/**
 * The log of an event-log server reached through `EventLogRemoteClient`, under an identity
 * generated for this layer's lifetime. Building it fails with `EventLogRemoteError` when the
 * server's handshake fails.
 */
export const layerSyncLogClient = (def: AnyDefinition) => {
  const storeId = syncStoreId(def)
  const identity = Layer.effect(EventLog.Identity, EventLog.makeIdentity).pipe(
    Layer.provide(EventLogEncryption.layerSubtle)
  )
  const remote = Layer.effect(EventLogRemote.EventLogRemote, EventLogRemote.makeUnencrypted).pipe(
    Layer.provide(EventLog.layerRegistry)
  )
  return Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const remote = yield* EventLogRemote.EventLogRemote
      const identity = yield* EventLog.Identity
      return SyncLog.of({
        append: (entry) => remote.write({ identity, storeId, entries: [entry] }),
        entries: (from) =>
          Stream.unwrap(
            Effect.map(remote.changes({ identity, storeId, startSequence: from }), (queue) => Stream.fromQueue(queue))
          )
      })
    })
  ).pipe(Layer.provide(Layer.merge(identity, remote)))
}

/** `layerSyncLogClient` over the client protocol in context, which carries `EventLogRemoteRpcs`. */
export const layerSyncLogRemote = (def: AnyDefinition) =>
  layerSyncLogClient(def).pipe(Layer.provide(EventLogRemote.EventLogRemoteClient.layer))

/**
 * Admits every identity to read the store, and a write only if every entry is a `Proposal` or a
 * `Joined` event (`syncGroup`). The event-log server stores an entry whose tag has no handler
 * without looking at it, so this is what keeps a writer from putting anything else in the log.
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
      const unknown = entries.find((entry) => entry.event !== PROPOSAL && entry.event !== JOINED)
      if (unknown === undefined) return Effect.void
      return Effect.fail(
        new EventLogServerUnencrypted.EventLogServerAuthError({
          reason: "Forbidden",
          publicKey,
          storeId,
          message: `"${unknown.event}" is not an event of this log`
        })
      )
    },
    authorizeRead: () => Effect.void,
    authorizeIdentity: () => Effect.void
  }
)

/**
 * The server side of the log for one definition: the `EventLogRemoteRpcs` handlers (serve them
 * with `RpcServer.layer(EventLogRemote.EventLogRemoteRpcs)`, whose protocol and serialization the
 * application picks) over an in-memory `Storage`, which it also provides for `layerSyncLogStorage`.
 * Only `Proposal` and `Joined` entries have a handler: a `Proposal` is decoded with the
 * definition's `proposal` schema and refused when it does not decode. An entry with any other tag
 * has no handler and is stored undecoded unless `EventLogServerAuthorization` refuses it, as
 * `layerSyncAuthorization` does. The log is volatile: it lives as long as this layer. The order of
 * its entries is the order in which writes reach `Storage`, one at a time.
 */
export const layerSyncServer = (def: AnyDefinition) => {
  const validation = EventLog.group(
    syncGroup(def),
    (handlers) => handlers.handle(PROPOSAL, () => Effect.void).handle(JOINED, () => Effect.void)
  )
  return Layer.mergeAll(EventLogServerUnencrypted.layerRpcHandlers, validation).pipe(
    Layer.provide(EventLogServerUnencrypted.layerStoreMappingStatic({ storeId: syncStoreId(def) })),
    Layer.provideMerge(EventLogServerUnencrypted.layerStorageMemory),
    Layer.provide(EventLog.layerRegistry)
  )
}
