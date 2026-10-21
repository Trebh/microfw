import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import { acceptBid, acceptClose, Auction, type Model, nap, type Representation, state } from "../src/domain/Auction.ts"
import { CreditCheck } from "../src/domain/CreditCheck.ts"

const base: Model = {
  item: "Vintage synth",
  minIncrement: 5,
  highest: Option.none(),
  bids: [],
  endsAt: 100_000,
  now: 40_000,
  status: "open",
  lastRejection: Option.none()
}

const bid = (amount: number, at: number) => ({ _tag: "Bid", bidder: "alice", amount, at }) as const

const representation = (overrides: Partial<Representation>): Representation => ({ ...state(base), ...overrides })

describe("acceptBid", () => {
  it("rejects a bid below the minimum and records no bid", () => {
    const next = acceptBid(base, bid(4, 40_000))

    assert.deepStrictEqual(next.lastRejection, Option.some("Bid must be at least 5"))
    assert.deepStrictEqual(next.bids, [])
  })

  it("extends the end to 10 seconds after a bid placed in the closing window", () => {
    const next = acceptBid(base, bid(5, 97_000))

    assert.strictEqual(next.endsAt, 107_000)
  })

  it("leaves the end unchanged for a bid placed before the closing window", () => {
    const next = acceptBid(base, bid(5, 70_000))

    assert.strictEqual(next.endsAt, 100_000)
  })

  it("rejects any bid once sold", () => {
    const next = acceptBid({ ...base, status: "sold" }, bid(500, 40_000))

    assert.deepStrictEqual([next.lastRejection, next.bids], [Option.some("Auction is closed"), []])
  })
})

describe("acceptClose", () => {
  it("keeps the auction open before the end", () => {
    assert.strictEqual(acceptClose({ ...base, now: 99_999 }, { _tag: "Close" }).status, "open")
  })

  it("sells the item at the end", () => {
    assert.strictEqual(acceptClose({ ...base, now: 100_000 }, { _tag: "Close" }).status, "sold")
  })
})

describe("state", () => {
  it("is closing with exactly 10 seconds left", () => {
    assert.strictEqual(state({ ...base, now: 90_000 }).controlState, "closing")
  })

  it("is open with 10.001 seconds left", () => {
    assert.strictEqual(state({ ...base, now: 89_999 }).controlState, "open")
  })

  it("never shows negative remaining seconds", () => {
    assert.strictEqual(state({ ...base, now: 100_001 }).remainingSeconds, 0)
  })
})

describe("nap", () => {
  it("stops once sold", () => {
    assert.deepStrictEqual(nap(representation({ controlState: "sold", remainingSeconds: 0 })), Option.none())
  })

  it("closes when no time is left", () => {
    assert.deepStrictEqual(nap(representation({ controlState: "closing", remainingSeconds: 0 })), Option.some({ _tag: "Close" }))
  })

  it("ticks while time is left", () => {
    assert.deepStrictEqual(nap(representation({ controlState: "closing", remainingSeconds: 1 })), Option.some({ _tag: "Tick" }))
  })
})

describe("PlaceBid action", () => {
  const placeBid = (bidder: string, amount: number) =>
    Auction.actions.PlaceBid({ _tag: "PlaceBid", bidder, amount }).pipe(Effect.provide(CreditCheck.layerLive))

  it.effect("rejects a bid over the bidder's credit limit", () =>
    Effect.gen(function*() {
      const proposal = yield* placeBid("alice", 101)

      assert.deepStrictEqual(proposal, { _tag: "BidRejected", bidder: "alice", reason: "Credit limit exceeded" })
    }))

  it.effect("stamps an accepted bid with the current time", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(5_000)

      const proposal = yield* placeBid("bob", 101)

      assert.deepStrictEqual(proposal, { _tag: "Bid", bidder: "bob", amount: 101, at: 5_000 })
    }))
})
