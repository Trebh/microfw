import { assert, describe, it } from "@effect/vitest"
import { AutoActions, layerLoopLocal, type StepRecord } from "@mufw/core"
import { Effect, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  acceptBid,
  acceptClose,
  acceptOpened,
  acceptsBids,
  acceptTick,
  Auction,
  initial,
  type Model,
  nap,
  type Representation,
  state
} from "../src/domain/Auction.ts"
import { layerCreditCheckTable } from "../src/adapters/creditCheckTable.ts"
import { layerCurrentBidderFixed } from "../src/adapters/currentBidderFixed.ts"
import { Amount, Bidder } from "../src/domain/Values.ts"
import { Ports } from "../src/ports.ts"

const base: Model = {
  item: "Vintage synth",
  minIncrement: Amount.make(5),
  highest: Option.none(),
  bids: [],
  endsAt: 100_000,
  now: 40_000,
  status: "open",
  lastRejection: Option.none()
}

const bid = (amount: number, at: number) =>
  ({ _tag: "Bid", bidder: Bidder.make("alice"), amount: Amount.make(amount), at }) as const

const representation = (overrides: Partial<Representation>): Representation => ({ ...state(base), ...overrides })

describe("acceptOpened", () => {
  it("starts the auction at the proposed time and ends it a full length later", () => {
    const next = acceptOpened(initial, { _tag: "Opened", at: 7_000 })

    assert.deepStrictEqual(
      [next.status, next.now, next.endsAt],
      ["open", 7_000, 67_000]
    )
  })

  it("ignores a second opening once the auction runs", () => {
    const next = acceptOpened(base, { _tag: "Opened", at: 500_000 })

    assert.deepStrictEqual(next, base)
  })
})

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

  it("rejects a bid before the auction opens", () => {
    const next = acceptBid(initial, bid(500, 0))

    assert.deepStrictEqual([next.lastRejection, next.bids], [Option.some("Auction has not opened"), []])
  })
})

describe("acceptTick", () => {
  it("leaves the clock untouched before the auction opens", () => {
    const next = acceptTick(initial, { _tag: "Tick", now: 9_000 })

    assert.strictEqual(next.now, 0)
  })
})

describe("acceptClose", () => {
  it("keeps the auction open before the end", () => {
    assert.strictEqual(acceptClose({ ...base, now: 99_999 }, { _tag: "Close" }).status, "open")
  })

  it("sells the item at the end", () => {
    assert.strictEqual(acceptClose({ ...base, now: 100_000 }, { _tag: "Close" }).status, "sold")
  })

  it("does not sell an auction that has not opened", () => {
    assert.strictEqual(acceptClose(initial, { _tag: "Close" }).status, "opening")
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
    assert.deepStrictEqual(nap(representation({ controlState: "sold", remainingSeconds: 0 })), Option.none())
  })

  it("opens an auction that has no start time", () => {
    assert.deepStrictEqual(nap(representation({ controlState: "opening" })), Option.some({ _tag: "Open" }))
  })

  it("closes when no time is left", () => {
    assert.deepStrictEqual(nap(representation({ controlState: "closing", remainingSeconds: 0 })), Option.some({ _tag: "Close" }))
  })

  it("ticks while time is left", () => {
    assert.deepStrictEqual(nap(representation({ controlState: "closing", remainingSeconds: 1 })), Option.some({ _tag: "Tick" }))
  })
})

describe("acceptsBids", () => {
  it("is false while the auction is opening", () => {
    assert.strictEqual(acceptsBids(state(initial)), false)
  })

  it("is true while the auction is open", () => {
    assert.strictEqual(acceptsBids(representation({ controlState: "open" })), true)
  })

  it("is true while the auction is closing", () => {
    assert.strictEqual(acceptsBids(representation({ controlState: "closing" })), true)
  })

  it("is false once the auction is sold", () => {
    assert.strictEqual(acceptsBids(representation({ controlState: "sold" })), false)
  })
})

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

      assert.deepStrictEqual(proposal, { _tag: "Bid", bidder: Bidder.make("bob"), amount: Amount.make(101), at: 5_000 })
    }))
})

describe("Open action", () => {
  it.effect("proposes the opening at the current clock", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(7_000)

      const proposal = yield* Auction.actions.Open({ _tag: "Open" }).pipe(
        Effect.provide(Layer.merge(layerCreditCheckTable, layerCurrentBidderFixed(Bidder.make("alice"))))
      )

      assert.deepStrictEqual(proposal, { _tag: "Opened", at: 7_000 })
    }))
})

describe("opening in the loop", () => {
  const Loop = layerLoopLocal(Auction, Ports).pipe(
    Layer.provide(Layer.merge(layerCreditCheckTable, layerCurrentBidderFixed(Bidder.make("alice"))))
  )
  const firstRecordWhere = (predicate: (record: StepRecord<typeof Auction>) => boolean) =>
    Ports.HistoryPort.use((history) => history.records.pipe(Stream.filter(predicate), Stream.runHead)).pipe(
      Effect.map(Option.getOrThrow)
    )

  it.effect("starts the auction at the clock when the loop starts", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(7_000)

      const opened = yield* firstRecordWhere((record) => record.model.status === "open").pipe(Effect.provide(Loop))

      assert.deepStrictEqual([opened.model.now, opened.model.endsAt], [7_000, 67_000])
    }))

  it.effect("reopens at the new clock after a reset to the initial model", () =>
    Effect.gen(function*() {
      const first = yield* firstRecordWhere((record) => record.model.status === "open")
      yield* Ports.HistoryPort.use((history) => history.travelTo(0))
      yield* TestClock.setTime(90_000)

      yield* Ports.IntentPort.use((port) => port.dispatch({ _tag: "Open" }))
      const reopened = yield* firstRecordWhere((record) => record.seq > first.seq && record.model.status === "open")

      assert.deepStrictEqual([reopened.model.now, reopened.model.endsAt], [90_000, 150_000])
    }).pipe(Effect.provide(Loop)))
})

describe("leaving opening by the user path", () => {
  const ManualLoop = layerLoopLocal(Auction, Ports).pipe(
    Layer.provide(Layer.merge(layerCreditCheckTable, layerCurrentBidderFixed(Bidder.make("alice")))),
    Layer.provide(Layer.succeed(AutoActions, false))
  )
  const latest = Ports.ModelPort.use((port) => Stream.runHead(port.representations)).pipe(Effect.map(Option.getOrThrow))
  const dispatchOpen = Ports.IntentPort.use((port) => port.dispatch({ _tag: "Open" }))
  const nextNotOpening = Ports.ModelPort.use((port) =>
    port.representations.pipe(Stream.filter((r) => r.controlState !== "opening"), Stream.runHead)
  ).pipe(Effect.map(Option.getOrThrow))

  it.effect("stays opening when automatic actions are off", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("5 seconds")

      assert.strictEqual((yield* latest).controlState, "opening")
    }).pipe(Effect.provide(ManualLoop)))

  it.effect("leaves opening when the user dispatches Open", () =>
    Effect.gen(function*() {
      yield* dispatchOpen

      assert.strictEqual((yield* nextNotOpening).controlState, "open")
    }).pipe(Effect.provide(ManualLoop)))

  it.effect("leaves opening by Open again after a travel to the initial record", () =>
    Effect.gen(function*() {
      yield* dispatchOpen
      yield* nextNotOpening
      yield* Ports.HistoryPort.use((history) => history.travelTo(0))
      const afterTravel = (yield* latest).controlState

      yield* dispatchOpen
      const afterReopen = (yield* nextNotOpening).controlState

      assert.deepStrictEqual([afterTravel, afterReopen], ["opening", "open"])
    }).pipe(Effect.provide(ManualLoop)))
})
