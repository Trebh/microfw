import type { Explore } from "@mufw/core"
import { Amount, Bidder } from "../domain/Values.ts"
import { type Auction, CLOSING_WINDOW, type Representation } from "./Auction.ts"

const alice = Bidder.make("alice")

/**
 * The only sample proposal before the auction opens is its opening at the model's clock. After it:
 * a valid and a too-low bid, a rejection, a tick to the next phase boundary (closing window, then
 * deadline) and a close.
 */
export const exploreAuction: Explore<typeof Auction> = (representation, model) => {
  if (representation.controlState === "opening") return [{ _tag: "Opened", at: model.now }]
  return [
    { _tag: "BidPlaced", bidder: alice, amount: representation.minimumBid, at: model.now },
    { _tag: "BidPlaced", bidder: alice, amount: Amount.make(Math.max(1, representation.minimumBid - 1)), at: model.now },
    { _tag: "BidRejected", bidder: alice, reason: "Credit limit exceeded" },
    { _tag: "Ticked", now: representation.controlState === "open" ? model.endsAt - CLOSING_WINDOW : model.endsAt },
    { _tag: "Closed" }
  ]
}

/** `closing` before and after the deadline enable different things (only the latter can close). */
export const serializeAuction = (representation: Representation) =>
  `${representation.controlState}:${representation.remainingSeconds === 0 ? "ended" : "running"}`
