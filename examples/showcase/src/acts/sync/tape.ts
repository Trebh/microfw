import { applyProposal } from "@mufw/core"
import { applyLease, Lease, type LeaseOutcome, type LeaseState, leaseOutcome, noLease } from "@mufw/core/sync"
import { Cause, Effect, Option, Schema } from "effect"
import { Event, EventJournal } from "effect/eventlog"
import { type Model as BoxModel, Proposal } from "../../domain/BoxOffice.ts"
import { Synced } from "./house.ts"

/** What one log entry says, read from its binary payload with the schemas the log's server decodes it with. */
export type Body =
  | { readonly _tag: "Proposal"; readonly proposal: Proposal }
  | { readonly _tag: "Joined" }
  | { readonly _tag: "Lease"; readonly lease: Lease }
  | { readonly _tag: "Unreadable"; readonly event: string }

export interface Logged {
  readonly seq: number
  /** When the writer formed the entry, from the timestamp in its id. */
  readonly at: number
  readonly body: Body
}

const proposalEvent = Event.make({ tag: "Proposal", primaryKey: () => Synced.name, payload: Proposal })
const leaseEvent = Event.make({ tag: "Lease", primaryKey: () => Synced.name, payload: Lease })
const decodeProposalPayload = Schema.decodeUnknownEffect(proposalEvent.payloadSchemaBinary)
const decodeLeasePayload = Schema.decodeUnknownEffect(leaseEvent.payloadSchemaBinary)

const decoders: Record<string, (payload: Uint8Array) => Effect.Effect<Body, Schema.SchemaError>> = {
  Proposal: (payload) =>
    Effect.map(decodeProposalPayload(payload), (proposal): Body => ({ _tag: "Proposal", proposal })),
  Lease: (payload) => Effect.map(decodeLeasePayload(payload), (lease): Body => ({ _tag: "Lease", lease })),
  Joined: () => Effect.succeed<Body>({ _tag: "Joined" })
}

/** Reads one entry as the log delivered it. An entry that does not decode is still on the tape, as unreadable. */
export const decodeEntry = (remote: EventJournal.RemoteEntry): Effect.Effect<Logged> => {
  const { entry } = remote
  const unreadable: Body = { _tag: "Unreadable", event: entry.event }
  const decode = decoders[entry.event]
  const body = decode === undefined
    ? Effect.succeed(unreadable)
    : decode(entry.payload).pipe(
      Effect.catch((error) =>
        Effect.logWarning("log entry not readable", entry.event, Cause.fail(error)).pipe(Effect.as(unreadable))
      )
    )
  return Effect.map(body, (decoded) => ({
    seq: remote.remoteSequence,
    at: EventJournal.entryIdMillis(entry.id),
    body: decoded
  }))
}

export interface Row {
  readonly seq: number
  readonly at: number
  /** `Proposal`, `Joined` or `Lease`: the event tag the log stores the entry under. */
  readonly event: string
  readonly label: string
  /** What the acceptors or the lease rule made of the entry, when there is something to say. */
  readonly detail: string
  /** The acceptors turned the proposal down, or the gateway did. */
  readonly refused: boolean
  /** Who the proposal acts for, when it names someone. */
  readonly patron: Option.Option<string>
  /** Lease renewals folded into this row, so that the holder's heartbeat does not bury the proposals. */
  readonly renewals: number
  /** `epoch:holder` of a lease row, empty for any other. */
  readonly leaseKey: string
}

/** The log as the tape shows it: newest row first, and what folding the whole log with the real acceptors gives. */
export interface Tape {
  readonly rows: ReadonlyArray<Row>
  readonly model: BoxModel
  readonly lease: LeaseState
  /** When the last entry that claimed or renewed the lease was formed. */
  readonly leaseAt: Option.Option<number>
  readonly lastSeq: Option.Option<number>
}

export const emptyTape: Tape = {
  rows: [],
  model: Synced.initial,
  lease: noLease,
  leaseAt: Option.none(),
  lastSeq: Option.none()
}

const ROW_LIMIT = 30

const SHORT_HOLDER = 6

const LEASE_WORDS: Record<LeaseOutcome, string> = {
  claimed: "took the lease",
  renewed: "renewed",
  ignored: "ignored"
}

const bareRow = (logged: Logged, event: string, label: string): Row => ({
  seq: logged.seq,
  at: logged.at,
  event,
  label,
  detail: "",
  refused: false,
  patron: Option.none(),
  renewals: 0,
  leaseKey: ""
})

const proposalLabel = (proposal: Proposal): string => {
  switch (proposal._tag) {
    case "SeatHeld":
    case "SeatSold":
    case "PaymentDeclined":
      return `${proposal._tag} ${proposal.seat}`
    case "DoorsOpened":
    case "Tick":
    case "CurtainUp":
      return proposal._tag
  }
}

const patronOf = (proposal: Proposal): Option.Option<string> =>
  proposal._tag === "SeatHeld" || proposal._tag === "SeatSold" ? Option.some(proposal.by) : Option.none()

/** Only these proposals can be turned down; any other leaves `lastRefusal` as an earlier one set it. */
const isJudged = (proposal: Proposal): boolean =>
  proposal._tag === "SeatHeld" || proposal._tag === "SeatSold" || proposal._tag === "PaymentDeclined"

const pushed = (tape: Tape, logged: Logged, row: Row, rest: Partial<Tape> = {}): Tape => ({
  ...tape,
  ...rest,
  rows: [row, ...tape.rows].slice(0, ROW_LIMIT),
  lastSeq: Option.some(logged.seq)
})

const withProposal = (tape: Tape, logged: Logged, proposal: Proposal): Tape => {
  const model = applyProposal(Synced, tape.model, proposal)
  const refusal = isJudged(proposal) ? model.lastRefusal : Option.none()
  const row: Row = {
    ...bareRow(logged, "Proposal", proposalLabel(proposal)),
    detail: Option.getOrElse(refusal, () => ""),
    refused: Option.isSome(refusal),
    patron: patronOf(proposal)
  }
  return pushed(tape, logged, row, { model })
}

const withLease = (tape: Tape, logged: Logged, lease: Lease): Tape => {
  const outcome = leaseOutcome(tape.lease, lease)
  const state = applyLease(tape.lease, lease)
  const leaseAt = outcome === "ignored" ? tape.leaseAt : Option.some(logged.at)
  const key = `${lease.epoch}:${lease.holder}`
  const top = tape.rows[0]
  if (outcome === "renewed" && top !== undefined && top.leaseKey === key) {
    const merged: Row = { ...top, seq: logged.seq, at: logged.at, renewals: top.renewals + 1 }
    return { ...tape, rows: [merged, ...tape.rows.slice(1)], lease: state, leaseAt, lastSeq: Option.some(logged.seq) }
  }
  const row: Row = {
    ...bareRow(logged, "Lease", `term ${lease.epoch} · ${lease.holder.slice(0, SHORT_HOLDER)}`),
    detail: LEASE_WORDS[outcome],
    leaseKey: key
  }
  return pushed(tape, logged, row, { lease: state, leaseAt })
}

/** The tape after one more entry, in the order the log delivers them. Pure: the acceptors and the lease rule are the instances' own. */
export const append = (tape: Tape, logged: Logged): Tape => {
  const { body } = logged
  switch (body._tag) {
    case "Proposal":
      return withProposal(tape, logged, body.proposal)
    case "Lease":
      return withLease(tape, logged, body.lease)
    case "Joined":
      return pushed(tape, logged, bareRow(logged, "Joined", "a window joined"))
    case "Unreadable":
      return pushed(tape, logged, bareRow(logged, body.event, "unreadable"))
  }
}

/** The log's last word to a patron: the newest proposal that names them, and what became of it. */
export interface Verdict {
  readonly seq: number
  readonly label: string
  readonly refused: boolean
  readonly detail: string
}

export const verdictFor = (tape: Tape, patron: string): Option.Option<Verdict> => {
  const row = tape.rows.find((candidate) => Option.exists(candidate.patron, (name) => name === patron))
  return Option.map(Option.fromNullishOr(row), ({ seq, label, refused, detail }) => ({ seq, label, refused, detail }))
}
