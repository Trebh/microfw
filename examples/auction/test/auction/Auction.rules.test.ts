import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import {
  acceptBidPlaced,
  acceptClosed,
  acceptOpened,
  acceptTicked,
  Auction,
  canBid,
  initial,
  state
} from "../../src/auction/Auction.ts"
import { base, bid, representation } from "./Auction.fixtures.ts"

describe("acceptOpened", () => {
  it("starts the auction at the proposed time and ends it a full length later", () => {
    const next = acceptOpened(initial, { _tag: "Opened", at: 7_000 })

    assert.deepStrictEqual(
      [next.phase, next.now, next.endsAt],
      ["open", 7_000, 67_000]
    )
  })

  it("ignores a second opening once the auction runs", () => {
    const next = acceptOpened(base, { _tag: "Opened", at: 500_000 })

    assert.deepStrictEqual(next, base)
  })
})

describe("acceptBidPlaced", () => {
  it("rejects a bid below the minimum and records no bid", () => {
    const next = acceptBidPlaced(base, bid(4, 40_000))

    assert.deepStrictEqual(next.lastRejection, Option.some("Bid must be at least 5"))
    assert.deepStrictEqual(next.bids, [])
  })

  it("extends the end to 10 seconds after a bid placed in the closing window", () => {
    const next = acceptBidPlaced(base, bid(5, 97_000))

    assert.strictEqual(next.endsAt, 107_000)
  })

  it("leaves the end unchanged for a bid placed before the closing window", () => {
    const next = acceptBidPlaced(base, bid(5, 70_000))

    assert.strictEqual(next.endsAt, 100_000)
  })

  it("rejects any bid once sold", () => {
    const next = acceptBidPlaced({ ...base, phase: "sold" }, bid(500, 40_000))

    assert.deepStrictEqual([next.lastRejection, next.bids], [Option.some("Auction is closed"), []])
  })

  it("rejects a bid before the auction opens", () => {
    const next = acceptBidPlaced(initial, bid(500, 0))

    assert.deepStrictEqual([next.lastRejection, next.bids], [Option.some("Auction has not opened"), []])
  })
})

describe("acceptTicked", () => {
  it("leaves the clock untouched before the auction opens", () => {
    const next = acceptTicked(initial, { _tag: "Ticked", now: 9_000 })

    assert.strictEqual(next.now, 0)
  })
})

describe("acceptClosed", () => {
  it("keeps the auction open before the end", () => {
    assert.strictEqual(acceptClosed({ ...base, now: 99_999 }).phase, "open")
  })

  it("sells the item at the end", () => {
    assert.strictEqual(acceptClosed({ ...base, now: 100_000 }).phase, "sold")
  })

  it("does not sell an auction that has not opened", () => {
    assert.strictEqual(acceptClosed(initial).phase, "opening")
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

describe("state of an unopened auction", () => {
  it("shows the full length as remaining time", () => {
    assert.deepStrictEqual(
      [state(initial).controlState, state(initial).remainingSeconds],
      ["opening", 60]
    )
  })
})

describe("nap", () => {
  it("stops once sold", () => {
    assert.deepStrictEqual(Auction.nap(representation({ controlState: "sold", remainingSeconds: 0 })), Option.none())
  })

  it("opens an auction that has no start time", () => {
    assert.deepStrictEqual(Auction.nap(representation({ controlState: "opening" })), Option.some({ _tag: "Open" }))
  })

  it("closes when no time is left", () => {
    assert.deepStrictEqual(
      Auction.nap(representation({ controlState: "closing", remainingSeconds: 0 })),
      Option.some({ _tag: "Close" })
    )
  })

  it("ticks while time is left", () => {
    assert.deepStrictEqual(
      Auction.nap(representation({ controlState: "closing", remainingSeconds: 1 })),
      Option.some({ _tag: "Tick" })
    )
  })
})

describe("canBid", () => {
  it("is false while the auction is opening", () => {
    assert.strictEqual(canBid(state(initial)), false)
  })

  it("is true while the auction is open", () => {
    assert.strictEqual(canBid(representation({ controlState: "open" })), true)
  })

  it("is true while the auction is closing", () => {
    assert.strictEqual(canBid(representation({ controlState: "closing" })), true)
  })

  it("is false once the auction is sold", () => {
    assert.strictEqual(canBid(representation({ controlState: "sold" })), false)
  })
})
