import { define, type Explore } from "@mufw/core"
import { Clock, Effect, Option, Schema } from "effect"
import { CreditCheck } from "./CreditCheck.ts"

export const Bid = Schema.Struct({ bidder: Schema.String, amount: Schema.Int, at: Schema.Number })
export type Bid = typeof Bid.Type

export const Model = Schema.Struct({
  item: Schema.String,
  minIncrement: Schema.Int,
  highest: Schema.Option(Bid),
  bids: Schema.Array(Bid),
  endsAt: Schema.Number,
  now: Schema.Number,
  status: Schema.Literals(["open", "sold"]),
  lastRejection: Schema.Option(Schema.String)
})
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("Bid", { bidder: Schema.String, amount: Schema.Int, at: Schema.Number }),
  Schema.TaggedStruct("BidRejected", { bidder: Schema.String, reason: Schema.String }),
  Schema.TaggedStruct("Tick", { now: Schema.Number }),
  Schema.TaggedStruct("Close", {})
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("PlaceBid", { bidder: Schema.String, amount: Schema.Int }),
  Schema.TaggedStruct("Tick", {}),
  Schema.TaggedStruct("Close", {})
])
export type Intent = typeof Intent.Type

export const Representation = Schema.Struct({
  controlState: Schema.Literals(["open", "closing", "sold"]),
  item: Schema.String,
  highest: Schema.Option(Bid),
  bids: Schema.Array(Bid),
  remainingSeconds: Schema.Int,
  minimumBid: Schema.Int,
  lastRejection: Schema.Option(Schema.String)
})
export type Representation = typeof Representation.Type

/** A bid in the last 10 seconds pushes the end to 10 seconds after it. */
const CLOSING_WINDOW = 10_000
const AUCTION_LENGTH = 60_000

const startedAt = Date.now()

export const initial: Model = {
  item: "Vintage synth",
  minIncrement: 5,
  highest: Option.none(),
  bids: [],
  endsAt: startedAt + AUCTION_LENGTH,
  now: startedAt,
  status: "open",
  lastRejection: Option.none()
}

export const minimumBid = (model: Model) =>
  Option.match(model.highest, {
    onNone: () => model.minIncrement,
    onSome: (highest) => highest.amount + model.minIncrement
  })

export const acceptBid = (model: Model, proposal: Proposal): Model => {
  if (proposal._tag !== "Bid") return model
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
  proposal._tag === "Tick" ? { ...model, now: Math.max(model.now, proposal.now) } : model

export const acceptClose = (model: Model, proposal: Proposal): Model => {
  const canClose = proposal._tag === "Close" && model.status === "open" && model.now >= model.endsAt
  return canClose ? { ...model, status: "sold" } : model
}

const controlStateOf = (model: Model): Representation["controlState"] => {
  if (model.status === "sold") return "sold"
  return model.endsAt - model.now <= CLOSING_WINDOW ? "closing" : "open"
}

export const state = (model: Model): Representation => ({
  controlState: controlStateOf(model),
  item: model.item,
  highest: model.highest,
  bids: model.bids,
  remainingSeconds: Math.max(0, Math.ceil((model.endsAt - model.now) / 1000)),
  minimumBid: minimumBid(model),
  lastRejection: model.lastRejection
})

export const nap = (representation: Representation): Option.Option<Intent> => {
  if (representation.controlState === "sold") return Option.none()
  return Option.some(representation.remainingSeconds === 0 ? { _tag: "Close" } : { _tag: "Tick" })
}

export const Auction = define({
  name: "auction",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  controlStates: ["open", "closing", "sold"],
  initial,
  acceptors: [acceptBid, acceptRejection, acceptTick, acceptClose],
  reactors: [],
  state,
  nap,
  actions: {
    PlaceBid: ({ bidder, amount }) =>
      Effect.gen(function*() {
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

/**
 * Sample proposals tried from every state: a valid and a too-low bid, a rejection, a tick to the
 * next phase boundary (closing window, then deadline) and a close.
 */
export const exploreAuction: Explore<typeof Auction> = (representation, model) => [
  { _tag: "Bid", bidder: "alice", amount: representation.minimumBid, at: model.now },
  { _tag: "Bid", bidder: "alice", amount: representation.minimumBid - 1, at: model.now },
  { _tag: "BidRejected", bidder: "alice", reason: "Credit limit exceeded" },
  { _tag: "Tick", now: representation.controlState === "open" ? model.endsAt - CLOSING_WINDOW : model.endsAt },
  { _tag: "Close" }
]

/** `closing` before and after the deadline enable different things (only the latter can close). */
export const serializeAuction = (representation: Representation) =>
  `${representation.controlState}:${representation.remainingSeconds === 0 ? "ended" : "running"}`
