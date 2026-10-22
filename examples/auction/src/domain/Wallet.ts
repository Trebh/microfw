import { define, type Explore } from "@mufw/core"
import { Effect, Option, Schema } from "effect"
import { Amount } from "./Values.ts"

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
export const acceptReserved = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "Reserved" && proposal.amount <= model.credit ? { ...model, reserved: proposal.amount } : model

export const acceptReleased = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "Released" ? { ...model, reserved: 0 } : model

/** A bid the wallet cannot back leaves nothing held: the reservation it replaces is gone with the old bid. */
export const acceptRefused = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "Refused" ? { ...model, reserved: 0 } : model

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

export const nap = (_representation: Representation): Option.Option<Intent> => Option.none()

/**
 * The wallet's credit never changes (no proposal moves it), so the action can judge an amount
 * against it and answer `Refused`; the acceptor still guards the invariant on its own.
 */
export const Wallet = define({
  name: "wallet",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  controlStates: ["funded", "exhausted"],
  initial,
  acceptors: [acceptReserved, acceptReleased, acceptRefused],
  reactors: [],
  state,
  nap,
  actions: {
    Reserve: ({ amount }) =>
      Effect.succeed(amount > CREDIT ? { _tag: "Refused", amount } as const : { _tag: "Reserved", amount } as const),
    Release: () => Effect.succeed({ _tag: "Released" })
  }
})

/** From any state: a part of the credit, all of it, more than it, and a release. */
export const exploreWallet: Explore<typeof Wallet> = (_representation, model) => [
  { _tag: "Reserved", amount: Amount.make(40) },
  { _tag: "Reserved", amount: Amount.make(model.credit) },
  { _tag: "Refused", amount: Amount.make(model.credit + 1) },
  { _tag: "Released" }
]

/** What is held is a finer identity than the control state: a part held and nothing held are both `funded`. */
export const serializeWallet = (representation: Representation) =>
  `${representation.controlState}:${representation.reserved}`
