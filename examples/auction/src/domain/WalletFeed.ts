import type { Forward } from "@mufw/core"
import { Option } from "effect"
import type { Representation as AuctionRepresentation, Auction } from "./Auction.ts"
import type { Bidder } from "./Values.ts"
import type { Intent as WalletIntent, Wallet } from "./Wallet.ts"

const RELEASE: WalletIntent = { _tag: "Release" }

/** What backs the bidder's standing in the auction: the leading bid if it is theirs, nothing otherwise. */
const holdFor = (bidder: Bidder) => (representation: AuctionRepresentation): WalletIntent =>
  Option.match(representation.highest, {
    onNone: () => RELEASE,
    onSome: (bid) => bid.bidder === bidder ? { _tag: "Reserve", amount: bid.amount } : RELEASE
  })

const sameHold = (left: WalletIntent, right: WalletIntent) =>
  left._tag === "Reserve" && right._tag === "Reserve" ? left.amount === right.amount : left._tag === right._tag

/**
 * The wallet of the page of `bidder` follows the auction: it reserves the amount of the leading bid
 * when it is the bidder's and releases otherwise. An intent is asked only when the hold changes, so
 * a tick or another bidder's rejection asks nothing. A wallet starts with nothing held, which is
 * what the first representation is compared with.
 */
export const holdForBids = (bidder: Bidder): Forward<typeof Auction, typeof Wallet> => (previous, current) => {
  const held = Option.match(previous, { onNone: () => RELEASE, onSome: holdFor(bidder) })
  const wanted = holdFor(bidder)(current)
  return sameHold(held, wanted) ? Option.none() : Option.some(wanted)
}
