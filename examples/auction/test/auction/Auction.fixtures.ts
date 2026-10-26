import { Layer, Option } from "effect"
import { layerCreditCheckTable } from "../../src/adapters/creditCheckTable.ts"
import { layerCurrentBidderFixed } from "../../src/adapters/currentBidderFixed.ts"
import { type Model, type Representation, state } from "../../src/auction/Auction.ts"
import { Amount, Bidder } from "../../src/domain/Values.ts"

/** An auction in its open phase, 60 s from its end. */
export const base: Model = {
  item: "Vintage synth",
  minIncrement: Amount.make(5),
  highest: Option.none(),
  bids: [],
  endsAt: 100_000,
  now: 40_000,
  phase: "open",
  lastRejection: Option.none()
}

export const bid = (amount: number, at: number) =>
  ({ _tag: "BidPlaced", bidder: Bidder.make("alice"), amount: Amount.make(amount), at }) as const

export const representation = (overrides: Partial<Representation>): Representation => ({ ...state(base), ...overrides })

/** The ports the auction's actions read, answering as bidder alice with the credit table. */
export const layerAliceBidding = Layer.merge(layerCreditCheckTable, layerCurrentBidderFixed(Bidder.make("alice")))
