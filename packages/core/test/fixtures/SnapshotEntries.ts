import { Effect, Schema } from "effect"
import { SchemaBinary } from "effect/encoding"
import { EventJournal } from "effect/eventlog"
import { noLease, SNAPSHOT, snapshotPayload } from "../../src/SyncEntry.ts"
import { Counter } from "./Counter.ts"

const encodeSnapshot = Schema.encodeEffect(SchemaBinary.toCodec(snapshotPayload(Counter)))

/** The encoded payload of a snapshot that stands for the entries up to `through`, with the Counter's initial model. */
export const snapshotPayloadThrough = (through: number) =>
  encodeSnapshot({ through, model: { count: 0 }, lease: noLease, applied: [] })

/** A `Snapshot` entry with that payload: what only a cut may put in a log. */
export const snapshotEntry = (through: number) =>
  Effect.map(snapshotPayloadThrough(through), (payload) =>
    new EventJournal.Entry({
      id: EventJournal.makeEntryIdUnsafe({ msecs: 0 }),
      event: SNAPSHOT,
      primaryKey: Counter.name,
      payload
    }, { disableChecks: true }))
