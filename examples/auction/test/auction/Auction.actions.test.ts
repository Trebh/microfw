import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { layerCreditCheckTable } from "../../src/adapters/creditCheckTable.ts"
import { layerCurrentBidderFixed } from "../../src/adapters/currentBidderFixed.ts"
import { Auction } from "../../src/auction/Auction.ts"
import { Amount, Bidder } from "../../src/domain/Values.ts"
import { layerAliceBidding } from "./Auction.fixtures.ts"

describe("PlaceBid action", () => {
  const placeBid = (bidder: string, amount: number) =>
    Auction.actions.PlaceBid({ _tag: "PlaceBid", amount: Amount.make(amount) }).pipe(
      Effect.provide(Layer.merge(layerCreditCheckTable, layerCurrentBidderFixed(Bidder.make(bidder))))
    )

  it.effect("rejects a bid over the bidder's credit limit", () =>
    Effect.gen(function*() {
      const proposal = yield* placeBid("alice", 101)

      assert.deepStrictEqual(proposal, {
        _tag: "BidRejected",
        bidder: Bidder.make("alice"),
        reason: "Credit limit exceeded"
      })
    }))

  it.effect("stamps an accepted bid with the current time", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(5_000)

      const proposal = yield* placeBid("bob", 101)

      assert.deepStrictEqual(proposal, { _tag: "BidPlaced", bidder: Bidder.make("bob"), amount: Amount.make(101), at: 5_000 })
    }))
})

describe("Open action", () => {
  it.effect("proposes the opening at the current clock", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(7_000)

      const proposal = yield* Auction.actions.Open({ _tag: "Open" }).pipe(
        Effect.provide(layerAliceBidding)
      )

      assert.deepStrictEqual(proposal, { _tag: "Opened", at: 7_000 })
    }))
})
