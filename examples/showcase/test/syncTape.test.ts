import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Event, EventJournal } from "effect/eventlog"
import { autoProposalSchema, InstanceId } from "@mufw/core/sync"
import { Synced } from "../src/acts/sync/ticketHouse.ts"
import { append, type Body, decodeEntry, emptyTape } from "../src/acts/sync/tape.ts"

const first = InstanceId.make("11111111111111111111111111111111")
const second = InstanceId.make("22222222222222222222222222222222")

const doorsOpened = { _tag: "DoorsOpened", at: 5 } as const

const foldTape = (bodies: ReadonlyArray<Body>) =>
  bodies.reduce((tape, body, seq) => append(tape, { seq, at: 0, body }), emptyTape)

const leaseTakenOver: ReadonlyArray<Body> = [
  { _tag: "Lease", lease: { epoch: 1, holder: first } },
  { _tag: "Lease", lease: { epoch: 2, holder: second } }
]

describe("the tape's reading of automatic proposals", () => {
  it("leaves the tape's model unchanged by an automatic proposal of an epoch the tape's lease has left", () => {
    const tape = foldTape([...leaseTakenOver, { _tag: "AutoProposal", epoch: 1, proposal: doorsOpened }])

    assert.deepStrictEqual(tape.model, Synced.initial)
  })

  it("marks the row of a skipped automatic proposal and says which term the log was not in", () => {
    const tape = foldTape([...leaseTakenOver, { _tag: "AutoProposal", epoch: 1, proposal: doorsOpened }])

    const row = tape.rows[0]
    assert.deepStrictEqual(
      { event: row?.event, skipped: row?.skipped, detail: row?.detail },
      { event: "AutoProposal", skipped: true, detail: "skipped: the log is not in term 1" }
    )
  })

  it("applies an automatic proposal of the epoch the tape's lease is in", () => {
    const tape = foldTape([...leaseTakenOver, { _tag: "AutoProposal", epoch: 2, proposal: doorsOpened }])

    assert.deepStrictEqual([tape.model.phase, tape.model.now], ["selling", 5])
  })

  it("does not mark the row of an automatic proposal that was applied", () => {
    const tape = foldTape([...leaseTakenOver, { _tag: "AutoProposal", epoch: 2, proposal: doorsOpened }])

    assert.isFalse(tape.rows[0]?.skipped)
  })

  it.effect("reads an automatic-proposal entry of the log", () =>
    Effect.gen(function*() {
      const event = Event.make({
        tag: "AutoProposal",
        primaryKey: () => Synced.name,
        payload: autoProposalSchema(Synced)
      })
      const payload = yield* Schema.encodeUnknownEffect(event.payloadSchemaBinary)({
        epoch: 2,
        proposal: doorsOpened
      })
      const entry = new EventJournal.Entry({
        id: EventJournal.makeEntryIdUnsafe({ msecs: 0 }),
        event: "AutoProposal",
        primaryKey: Synced.name,
        payload
      }, { disableChecks: true })

      const logged = yield* decodeEntry(new EventJournal.RemoteEntry({ remoteSequence: 7, entry }))

      assert.deepStrictEqual(logged.body, { _tag: "AutoProposal", epoch: 2, proposal: doorsOpened })
    }))
})
