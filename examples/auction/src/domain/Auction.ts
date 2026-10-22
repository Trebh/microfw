import { define, type Explore } from "@mufw/core"
import { Clock, Effect, Option, Schema } from "effect"
import { CreditCheck } from "./CreditCheck.ts"
import { CurrentBidder } from "./CurrentBidder.ts"
import { Amount, Bidder } from "./Values.ts"

export const Bid = Schema.Struct({ bidder: Bidder, amount: Amount, at: Schema.Number })
export type Bid = typeof Bid.Type

export const Model = Schema.Struct({
  item: Schema.String,
  minIncrement: Amount,
  highest: Schema.Option(Bid),
  bids: Schema.Array(Bid),
  endsAt: Schema.Number,
  now: Schema.Number,
  status: Schema.Literals(["opening", "open", "sold"]),
  lastRejection: Schema.Option(Schema.String)
})
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("Bid", { bidder: Bidder, amount: Amount, at: Schema.Number }),
  Schema.TaggedStruct("BidRejected", { bidder: Bidder, reason: Schema.String }),
  Schema.TaggedStruct("Opened", { at: Schema.Number }),
  Schema.TaggedStruct("Tick", { now: Schema.Number }),
  Schema.TaggedStruct("Close", {})
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
const CLOSING_WINDOW = 10_000
export const AUCTION_LENGTH = 60_000

/** The auction has no start time until `Opened`: the clock belongs to the environment, not the module. */
export const initial: Model = {
  item: "Vintage synth",
  minIncrement: Amount.make(5),
  highest: Option.none(),
  bids: [],
  endsAt: 0,
  now: 0,
  status: "opening",
  lastRejection: Option.none()
}

export const minimumBid = (model: Model): Amount =>
  Option.match(model.highest, {
    onNone: () => model.minIncrement,
    onSome: (highest) => Amount.make(highest.amount + model.minIncrement)
  })

export const acceptOpened = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "Opened" && model.status === "opening"
    ? { ...model, status: "open", now: proposal.at, endsAt: proposal.at + AUCTION_LENGTH }
    : model

export const acceptBid = (model: Model, proposal: Proposal): Model => {
  if (proposal._tag !== "Bid") return model
  if (model.status === "opening") return { ...model, lastRejection: Option.some("Auction has not opened") }
  if (model.status === "sold") return { ...model, lastRejection: Option.some("Auction is closed") }
  const minimum = minimumBid(model)
  if (proposal.amount < minimum) return { ...model, lastRejection: Option.some(`Bid must be at least ${minimum}`) }
  const bid = { bidder: proposal.bidder, amount: proposal.amount, at: proposal.at }
  return {
    ...model,
    bids: [...model.bids, bid],
    highest: Option.some(bid),
    endsAt: Math.max(model.endsAt, bid.at + CLOSING_WINDOW),
    lastRejection: Option.none()
  }
}

export const acceptRejection = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "BidRejected" ? { ...model, lastRejection: Option.some(proposal.reason) } : model

export const acceptTick = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "Tick" && model.status !== "opening" ? { ...model, now: Math.max(model.now, proposal.now) } : model

export const acceptClose = (model: Model, proposal: Proposal): Model => {
  const canClose = proposal._tag === "Close" && model.status === "open" && model.now >= model.endsAt
  return canClose ? { ...model, status: "sold" } : model
}

const controlStateOf = (model: Model): Representation["controlState"] => {
  if (model.status !== "open") return model.status
  return model.endsAt - model.now <= CLOSING_WINDOW ? "closing" : "open"
}

const remainingSecondsOf = (model: Model): number =>
  model.status === "opening" ? AUCTION_LENGTH / 1000 : Math.max(0, Math.ceil((model.endsAt - model.now) / 1000))

export const state = (model: Model): Representation => ({
  controlState: controlStateOf(model),
  item: model.item,
  highest: model.highest,
  bids: model.bids,
  remainingSeconds: remainingSecondsOf(model),
  minimumBid: minimumBid(model),
  lastRejection: model.lastRejection
})

export const nap = (representation: Representation): Option.Option<Intent> => {
  if (representation.controlState === "sold") return Option.none()
  if (representation.controlState === "opening") return Option.some({ _tag: "Open" })
  return Option.some(representation.remainingSeconds === 0 ? { _tag: "Close" } : { _tag: "Tick" })
}

/** Whether the representation invites a bid: not before the auction opens, not once it is sold. */
export const acceptsBids = (representation: Representation): boolean =>
  representation.controlState === "open" || representation.controlState === "closing"

export const Auction = define({
  name: "auction",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  controlStates: ["opening", "open", "closing", "sold"],
  initial,
  acceptors: [acceptOpened, acceptBid, acceptRejection, acceptTick, acceptClose],
  reactors: [],
  state,
  nap,
  actions: {
    Open: () => Clock.currentTimeMillis.pipe(Effect.map((at) => ({ _tag: "Opened", at }) as const)),
    PlaceBid: ({ amount }) =>
      Effect.gen(function*() {
        const { bidder } = yield* CurrentBidder
        const limit = yield* CreditCheck.use((credit) => credit.limit(bidder))
        if (amount > limit) return { _tag: "BidRejected", bidder, reason: "Credit limit exceeded" } as const
        return { _tag: "Bid", bidder, amount, at: yield* Clock.currentTimeMillis } as const
      }),
    Tick: () =>
      Effect.sleep("1 second").pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.map((now) => ({ _tag: "Tick", now }) as const)
      ),
    Close: () => Effect.succeed({ _tag: "Close" })
  }
})

const alice = Bidder.make("alice")

/**
 * The only sample proposal before the auction opens is its opening at the model's clock. After it:
 * a valid and a too-low bid, a rejection, a tick to the next phase boundary (closing window, then
 * deadline) and a close.
 */
export const exploreAuction: Explore<typeof Auction> = (representation, model) => {
  if (representation.controlState === "opening") return [{ _tag: "Opened", at: model.now }]
  return [
    { _tag: "Bid", bidder: alice, amount: representation.minimumBid, at: model.now },
    { _tag: "Bid", bidder: alice, amount: Amount.make(Math.max(1, representation.minimumBid - 1)), at: model.now },
    { _tag: "BidRejected", bidder: alice, reason: "Credit limit exceeded" },
    { _tag: "Tick", now: representation.controlState === "open" ? model.endsAt - CLOSING_WINDOW : model.endsAt },
    { _tag: "Close" }
  ]
}

/** `closing` before and after the deadline enable different things (only the latter can close). */
export const serializeAuction = (representation: Representation) =>
  `${representation.controlState}:${representation.remainingSeconds === 0 ? "ended" : "running"}`
