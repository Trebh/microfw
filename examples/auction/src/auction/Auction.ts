import { define, noIntent, type WithTag } from "@mufw/core"
import { Clock, Effect, Option, Schema } from "effect"
import { CreditCheck } from "../domain/CreditCheck.ts"
import { CurrentBidder } from "../domain/CurrentBidder.ts"
import { Amount, Bidder } from "../domain/Values.ts"

export const Bid = Schema.Struct({ bidder: Bidder, amount: Amount, at: Schema.Number })
export type Bid = typeof Bid.Type

export const Model = Schema.Struct({
  item: Schema.String,
  minIncrement: Amount,
  highest: Schema.Option(Bid),
  bids: Schema.Array(Bid),
  endsAt: Schema.Number,
  now: Schema.Number,
  phase: Schema.Literals(["opening", "open", "sold"]),
  lastRejection: Schema.Option(Schema.String)
})
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("BidPlaced", { bidder: Bidder, amount: Amount, at: Schema.Number }),
  Schema.TaggedStruct("BidRejected", { bidder: Bidder, reason: Schema.String }),
  Schema.TaggedStruct("Opened", { at: Schema.Number }),
  Schema.TaggedStruct("Ticked", { now: Schema.Number }),
  Schema.TaggedStruct("Closed", {})
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("Open", {}),
  Schema.TaggedStruct("PlaceBid", { amount: Amount }),
  Schema.TaggedStruct("Tick", {}),
  Schema.TaggedStruct("Close", {})
])
export type Intent = typeof Intent.Type

export const Representation = Schema.Struct({
  controlState: Schema.Literals(["opening", "open", "closing", "sold"]),
  item: Schema.String,
  highest: Schema.Option(Bid),
  bids: Schema.Array(Bid),
  remainingSeconds: Schema.Int,
  minimumBid: Amount,
  lastRejection: Schema.Option(Schema.String)
})
export type Representation = typeof Representation.Type

/** A bid in the last 10 seconds pushes the end to 10 seconds after it. */
export const CLOSING_WINDOW = 10_000
export const AUCTION_LENGTH = 60_000

/** The auction has no start time until `Opened`: the clock belongs to the environment, not the module. */
export const initial: Model = {
  item: "Vintage synth",
  minIncrement: Amount.make(5),
  highest: Option.none(),
  bids: [],
  endsAt: 0,
  now: 0,
  phase: "opening",
  lastRejection: Option.none()
}

export const minimumBid = (model: Model): Amount =>
  Option.match(model.highest, {
    onNone: () => model.minIncrement,
    onSome: (highest) => Amount.make(highest.amount + model.minIncrement)
  })

/** Why the model refuses a bid, or none when it takes it. */
export const bidRefusal = (
  model: Model,
  bid: WithTag<Proposal, "BidPlaced">
): Option.Option<string> => {
  if (model.phase === "opening") return Option.some("Auction has not opened")
  if (model.phase === "sold") return Option.some("Auction is closed")
  const minimum = minimumBid(model)
  return bid.amount < minimum ? Option.some(`Bid must be at least ${minimum}`) : Option.none()
}

export const acceptBidPlaced = (model: Model, bid: WithTag<Proposal, "BidPlaced">): Model => {
  const refusal = bidRefusal(model, bid)
  if (Option.isSome(refusal)) return { ...model, lastRejection: refusal }
  const placed = { bidder: bid.bidder, amount: bid.amount, at: bid.at }
  return {
    ...model,
    bids: [...model.bids, placed],
    highest: Option.some(placed),
    endsAt: Math.max(model.endsAt, placed.at + CLOSING_WINDOW),
    lastRejection: Option.none()
  }
}

export const acceptBidRejected = (
  model: Model,
  proposal: WithTag<Proposal, "BidRejected">
): Model => ({ ...model, lastRejection: Option.some(proposal.reason) })

export const acceptOpened = (model: Model, proposal: WithTag<Proposal, "Opened">): Model =>
  model.phase === "opening"
    ? { ...model, phase: "open", now: proposal.at, endsAt: proposal.at + AUCTION_LENGTH }
    : model

export const acceptTicked = (model: Model, proposal: WithTag<Proposal, "Ticked">): Model =>
  model.phase !== "opening" ? { ...model, now: Math.max(model.now, proposal.now) } : model

export const acceptClosed = (model: Model): Model =>
  model.phase === "open" && model.now >= model.endsAt ? { ...model, phase: "sold" } : model

export const state = (model: Model): Representation => ({
  controlState: controlStateOf(model),
  item: model.item,
  highest: model.highest,
  bids: model.bids,
  remainingSeconds: remainingSecondsOf(model),
  minimumBid: minimumBid(model),
  lastRejection: model.lastRejection
})

const controlStateOf = (model: Model): Representation["controlState"] => {
  if (model.phase !== "open") return model.phase
  return model.endsAt - model.now <= CLOSING_WINDOW ? "closing" : "open"
}

const remainingSecondsOf = (model: Model): number =>
  model.phase === "opening" ? AUCTION_LENGTH / 1000 : Math.max(0, Math.ceil((model.endsAt - model.now) / 1000))

const napOpening = (): Option.Option<Intent> => Option.some({ _tag: "Open" })

const napOpen = (): Option.Option<Intent> => Option.some({ _tag: "Tick" })

const napClosing = (representation: Representation): Option.Option<Intent> =>
  Option.some(representation.remainingSeconds === 0 ? { _tag: "Close" } : { _tag: "Tick" })

/** Whether the representation invites a bid: not before the auction opens, not once it is sold. */
export const canBid = (representation: Representation): boolean =>
  representation.controlState === "open" || representation.controlState === "closing"

const openAuction = () => Clock.currentTimeMillis.pipe(Effect.map((at) => ({ _tag: "Opened", at }) as const))

/**
 * The credit limit is decided here and not in an acceptor: the answer comes from the `CreditCheck` port,
 * which only a server answers bindingly.
 */
const placeBid = ({ amount }: WithTag<Intent, "PlaceBid">) =>
  Effect.gen(function*() {
    const { bidder } = yield* CurrentBidder
    const limit = yield* CreditCheck.use((credit) => credit.limit(bidder))
    if (amount > limit) return { _tag: "BidRejected", bidder, reason: "Credit limit exceeded" } as const
    return { _tag: "BidPlaced", bidder, amount, at: yield* Clock.currentTimeMillis } as const
  })

const tick = () =>
  Effect.sleep("1 second").pipe(
    Effect.andThen(Clock.currentTimeMillis),
    Effect.map((now) => ({ _tag: "Ticked", now }) as const)
  )

const closeAuction = () => Effect.succeed({ _tag: "Closed" } as const)

export const Auction = define({
  name: "auction",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  initial,
  acceptors: {
    BidPlaced: acceptBidPlaced,
    BidRejected: acceptBidRejected,
    Opened: acceptOpened,
    Ticked: acceptTicked,
    Closed: acceptClosed
  },
  reactors: [],
  state,
  nap: { opening: napOpening, open: napOpen, closing: napClosing, sold: noIntent },
  actions: { Open: openAuction, PlaceBid: placeBid, Tick: tick, Close: closeAuction }
})
