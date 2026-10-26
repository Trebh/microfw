import { define, noIntent, type WithTag } from "@mufw/core"
import { Effect, Schema } from "effect"
import { Amount } from "../domain/Values.ts"

/** A sum of whole units that may be nothing: what is held or what is left. */
export const Units = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
export type Units = typeof Units.Type

export const Model = Schema.Struct({ credit: Units, reserved: Units })
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("Reserved", { amount: Amount }),
  Schema.TaggedStruct("Released", {}),
  Schema.TaggedStruct("Refused", { amount: Amount })
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("Reserve", { amount: Amount }),
  Schema.TaggedStruct("Release", {})
])
export type Intent = typeof Intent.Type

export const Representation = Schema.Struct({
  controlState: Schema.Literals(["funded", "exhausted"]),
  credit: Units,
  reserved: Units,
  available: Units
})
export type Representation = typeof Representation.Type

/** What a wallet starts with: the limit the server's table gives its default bidder. */
export const CREDIT = 100

export const initial: Model = { credit: CREDIT, reserved: 0 }

/**
 * A reservation replaces the previous one: the wallet holds what backs the page's leading bid, never
 * a sum of bids. One above the credit would break `reserved <= credit`, so it is ignored.
 */
export const acceptReserved = (model: Model, proposal: WithTag<Proposal, "Reserved">): Model =>
  proposal.amount <= model.credit ? { ...model, reserved: proposal.amount } : model

/**
 * `Released` and `Refused` both leave nothing held: a bid the wallet cannot back takes the reservation
 * it replaces down with the old bid.
 */
export const clearReservation = (model: Model): Model => ({ ...model, reserved: 0 })

/** `exhausted` once every unit of credit is held, `funded` while some is left. */
export const state = (model: Model): Representation => {
  const available = model.credit - model.reserved
  return {
    controlState: available === 0 ? "exhausted" : "funded",
    credit: model.credit,
    reserved: model.reserved,
    available
  }
}

/**
 * The wallet's credit never changes (no proposal moves it), so the action can judge an amount
 * against it and answer `Refused`; the acceptor still guards the invariant on its own.
 */
const reserve = ({ amount }: WithTag<Intent, "Reserve">) =>
  Effect.succeed(amount > CREDIT ? { _tag: "Refused", amount } as const : { _tag: "Reserved", amount } as const)

const release = () => Effect.succeed({ _tag: "Released" } as const)

export const Wallet = define({
  name: "wallet",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  initial,
  acceptors: { Reserved: acceptReserved, Released: clearReservation, Refused: clearReservation },
  reactors: [],
  state,
  nap: { funded: noIntent, exhausted: noIntent },
  actions: { Reserve: reserve, Release: release }
})
