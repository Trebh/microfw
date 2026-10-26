import { assert, describe, it } from "@effect/vitest"
import { applyProposal } from "@mufw/core"
import { Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { layerCurrentPatronFixed } from "../src/adapters/currentPatronFixed.ts"
import { layerPaymentTheatrical } from "../src/adapters/paymentTheatrical.ts"
import {
  acceptCurtainRaised,
  acceptDoorsOpened,
  acceptSeatHeld,
  acceptSeatSold,
  acceptTicked,
  BoxOffice,
  initial,
  type Intent,
  type Model,
  type Place,
  Patron,
  releaseExpiredHolds,
  SEAT_IDS,
  type SeatId,
  state
} from "../src/domain/BoxOffice.ts"

const alice = Patron.make("alice")
const bob = Patron.make("bob")

const free = (seat: SeatId): Place => ({ _tag: "Free", seat })
const held = (seat: SeatId, by: Patron, until: number): Place => ({ _tag: "Held", seat, by, until })
const sold = (seat: SeatId, by: Patron): Place => ({ _tag: "Sold", seat, by })

const house = (places: Partial<Record<SeatId, Place>>): ReadonlyArray<Place> =>
  SEAT_IDS.map((seat) => places[seat] ?? free(seat))

const selling = (places: Partial<Record<SeatId, Place>> = {}, overrides: Partial<Model> = {}): Model => ({
  ...initial,
  phase: "selling",
  seats: house(places),
  ...overrides
})

const placeAt = (model: Model, seat: SeatId) => model.seats.find((place) => place.seat === seat)

const everySeat = (place: (seat: SeatId) => Place): ReadonlyArray<Place> => SEAT_IDS.map(place)

describe("acceptDoorsOpened", () => {
  it("opens the doors at the proposed time", () => {
    const result = acceptDoorsOpened(initial, { _tag: "DoorsOpened", at: 4_000 })

    assert.deepStrictEqual([result.phase, result.now], ["selling", 4_000])
  })

  it("ignores a second opening", () => {
    const open = selling({}, { now: 4_000 })

    const result = acceptDoorsOpened(open, { _tag: "DoorsOpened", at: 9_000 })

    assert.strictEqual(result, open)
  })
})

describe("acceptSeatHeld", () => {
  it("holds a free seat for the patron until the hold runs out", () => {
    const result = acceptSeatHeld(selling(), { _tag: "SeatHeld", seat: "A1", by: alice, at: 1_000 })

    assert.deepStrictEqual(placeAt(result, "A1"), held("A1", alice, 9_000))
  })

  it("moves the clock to the time of the hold", () => {
    const result = acceptSeatHeld(selling({}, { now: 500 }), { _tag: "SeatHeld", seat: "A1", by: alice, at: 1_000 })

    assert.strictEqual(result.now, 1_000)
  })

  it("clears an earlier refusal once a hold succeeds", () => {
    const refused = selling({}, { lastRefusal: Option.some("B2 is taken") })

    const result = acceptSeatHeld(refused, { _tag: "SeatHeld", seat: "A1", by: alice, at: 1_000 })

    assert.deepStrictEqual(result.lastRefusal, Option.none())
  })

  it("records a refusal when the seat is taken", () => {
    const taken = selling({ A1: held("A1", bob, 9_000) })

    const result = acceptSeatHeld(taken, { _tag: "SeatHeld", seat: "A1", by: alice, at: 1_000 })

    assert.deepStrictEqual(result.lastRefusal, Option.some("A1 is taken"))
  })

  it("leaves every seat as it was when the seat is taken", () => {
    const taken = selling({ A1: held("A1", bob, 9_000) })

    const result = acceptSeatHeld(taken, { _tag: "SeatHeld", seat: "A1", by: alice, at: 1_000 })

    assert.deepStrictEqual(result.seats, taken.seats)
  })

  it("refuses a hold while the doors are closed", () => {
    const result = acceptSeatHeld(initial, { _tag: "SeatHeld", seat: "A1", by: alice, at: 1_000 })

    assert.deepStrictEqual(result.lastRefusal, Option.some("the doors are not open yet"))
  })
})

describe("acceptSeatSold", () => {
  it("sells a seat held by the same patron", () => {
    const result = acceptSeatSold(selling({ A1: held("A1", alice, 9_000) }), {
      _tag: "SeatSold",
      seat: "A1",
      by: alice
    })

    assert.deepStrictEqual(placeAt(result, "A1"), sold("A1", alice))
  })

  it("refuses a sale of a seat held by another patron", () => {
    const bobsHold = selling({ A1: held("A1", bob, 9_000) })

    const result = acceptSeatSold(bobsHold, { _tag: "SeatSold", seat: "A1", by: alice })

    assert.deepStrictEqual(
      [placeAt(result, "A1"), result.lastRefusal],
      [held("A1", bob, 9_000), Option.some("A1 is not held for alice")]
    )
  })

  it("refuses a sale of a seat nobody holds", () => {
    const result = acceptSeatSold(selling(), { _tag: "SeatSold", seat: "A1", by: alice })

    assert.deepStrictEqual(
      [placeAt(result, "A1"), result.lastRefusal],
      [free("A1"), Option.some("A1 is not held for alice")]
    )
  })

  it("sells nothing after the curtain", () => {
    const afterCurtain: Model = { ...selling({ A1: held("A1", alice, 9_000) }), phase: "curtain" }

    const result = acceptSeatSold(afterCurtain, { _tag: "SeatSold", seat: "A1", by: alice })

    assert.deepStrictEqual(
      [placeAt(result, "A1"), result.lastRefusal],
      [held("A1", alice, 9_000), Option.some("the curtain is up")]
    )
  })
})

describe("acceptTicked", () => {
  it("only moves the clock: the reactor does the releasing", () => {
    const holding = selling({ A1: held("A1", alice, 9_000) }, { now: 1_000 })

    const result = acceptTicked(holding, { _tag: "Ticked", now: 9_500 })

    assert.deepStrictEqual([result.now, placeAt(result, "A1")], [9_500, held("A1", alice, 9_000)])
  })

  it("never moves the clock back", () => {
    const result = acceptTicked(selling({}, { now: 5_000 }), { _tag: "Ticked", now: 2_000 })

    assert.strictEqual(result.now, 5_000)
  })

  it("is ignored while the doors are closed", () => {
    const result = acceptTicked(initial, { _tag: "Ticked", now: 2_000 })

    assert.strictEqual(result, initial)
  })
})

describe("acceptCurtainRaised", () => {
  it("raises the curtain", () => {
    const result = acceptCurtainRaised(selling(), { _tag: "CurtainRaised", at: 20_000 })

    assert.deepStrictEqual([result.phase, result.now], ["curtain", 20_000])
  })

  it("lets go of holds and keeps sales", () => {
    const busy = selling({ A1: held("A1", alice, 30_000), A2: sold("A2", bob) })

    const result = acceptCurtainRaised(busy, { _tag: "CurtainRaised", at: 20_000 })

    assert.deepStrictEqual(
      [placeAt(result, "A1"), placeAt(result, "A2")],
      [free("A1"), sold("A2", bob)]
    )
  })

  it("is ignored while the doors are closed", () => {
    const result = acceptCurtainRaised(initial, { _tag: "CurtainRaised", at: 20_000 })

    assert.strictEqual(result, initial)
  })
})

describe("releaseExpiredHolds", () => {
  it("frees a hold whose time is up", () => {
    const result = releaseExpiredHolds(selling({ A1: held("A1", alice, 9_000) }, { now: 9_001 }))

    assert.deepStrictEqual(placeAt(result, "A1"), free("A1"))
  })

  it("frees a hold at the very moment it runs out", () => {
    const result = releaseExpiredHolds(selling({ A1: held("A1", alice, 9_000) }, { now: 9_000 }))

    assert.deepStrictEqual(placeAt(result, "A1"), free("A1"))
  })

  it("keeps a hold that still has time", () => {
    const result = releaseExpiredHolds(selling({ A1: held("A1", alice, 9_000) }, { now: 8_999 }))

    assert.deepStrictEqual(placeAt(result, "A1"), held("A1", alice, 9_000))
  })

  it("keeps a sale however late the clock", () => {
    const result = releaseExpiredHolds(selling({ A1: sold("A1", alice) }, { now: 99_000 }))

    assert.deepStrictEqual(placeAt(result, "A1"), sold("A1", alice))
  })
})

describe("a tick past the hold, through the step", () => {
  it("frees the seat", () => {
    const holding = selling({ A1: held("A1", alice, 9_000) }, { now: 1_000 })

    const result = applyProposal(BoxOffice, holding, { _tag: "Ticked", now: 9_000 })

    assert.deepStrictEqual(placeAt(result, "A1"), free("A1"))
  })

  it("keeps the seat before its time", () => {
    const holding = selling({ A1: held("A1", alice, 9_000) }, { now: 1_000 })

    const result = applyProposal(BoxOffice, holding, { _tag: "Ticked", now: 8_999 })

    assert.deepStrictEqual(placeAt(result, "A1"), held("A1", alice, 9_000))
  })
})

describe("state", () => {
  it("is dark before the doors open", () => {
    assert.strictEqual(state(initial).controlState, "dark")
  })

  it("is selling while a seat is free", () => {
    assert.strictEqual(state(selling({ A1: sold("A1", alice) })).controlState, "selling")
  })

  it("is full when no seat is free, held or sold", () => {
    const everyoneInside = selling({}, {
      seats: everySeat((seat) => (seat === "A1" ? sold(seat, alice) : held(seat, bob, 9_000)))
    })

    assert.strictEqual(state(everyoneInside).controlState, "full")
  })

  it("is curtain once the curtain is up", () => {
    assert.strictEqual(state({ ...selling(), phase: "curtain" }).controlState, "curtain")
  })

  it("counts free, held and sold seats", () => {
    const busy = selling({ A1: sold("A1", alice), A2: held("A2", bob, 9_000), A3: held("A3", bob, 9_000) })
    const representation = state(busy)

    assert.deepStrictEqual([representation.free, representation.held, representation.sold], [15, 2, 1])
  })

  it("lists the seats in house order with who holds them", () => {
    const representation = state(selling({ A2: held("A2", bob, 9_000) }))

    assert.deepStrictEqual(representation.seats[1], {
      id: "A2",
      status: "held",
      by: Option.some(bob),
      heldUntil: Option.some(9_000)
    })
  })
})

describe("nap", () => {
  it("awaits the earliest hold", () => {
    const holding = selling({ A1: held("A1", alice, 9_000), B2: held("B2", bob, 5_000) })

    assert.deepStrictEqual(BoxOffice.nap(state(holding)), Option.some<Intent>({ _tag: "AwaitExpiry", until: 5_000 }))
  })

  it("awaits the earliest hold while the house is full of holds", () => {
    const everyoneInside = selling({}, { seats: everySeat((seat) => held(seat, bob, seat === "C6" ? 4_000 : 9_000)) })

    assert.deepStrictEqual(
      BoxOffice.nap(state(everyoneInside)),
      Option.some<Intent>({ _tag: "AwaitExpiry", until: 4_000 })
    )
  })

  it("raises the curtain when every seat is sold", () => {
    const soldOut = selling({}, { seats: everySeat((seat) => sold(seat, alice)) })

    assert.deepStrictEqual(BoxOffice.nap(state(soldOut)), Option.some<Intent>({ _tag: "RaiseCurtain" }))
  })

  it("has nothing to say with no hold", () => {
    assert.deepStrictEqual(BoxOffice.nap(state(selling({ A1: sold("A1", alice) }))), Option.none())
  })

  it("has nothing to say before the doors open", () => {
    assert.deepStrictEqual(BoxOffice.nap(state(initial)), Option.none())
  })

  it("has nothing to say once the curtain is up", () => {
    assert.deepStrictEqual(BoxOffice.nap(state({ ...selling(), phase: "curtain" })), Option.none())
  })
})

describe("actions", () => {
  const Stage = Layer.merge(layerPaymentTheatrical, layerCurrentPatronFixed(alice))
  const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true })

  it.effect("Hold proposes the seat for the current patron at the clock", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(3_000)

      const proposal = yield* BoxOffice.actions.Hold({ _tag: "Hold", seat: "B3" }).pipe(Effect.provide(Stage))

      assert.deepStrictEqual(proposal, { _tag: "SeatHeld", seat: "B3", by: alice, at: 3_000 })
    }))

  it.effect("Pay sells the seat once the gateway has charged", () =>
    Effect.gen(function*() {
      const paying = yield* Effect.forkChild(
        BoxOffice.actions.Pay({ _tag: "Pay", seat: "A1" }).pipe(Effect.provide(Stage))
      )
      yield* settle
      yield* TestClock.adjust("1100 millis")

      const proposal = yield* Fiber.join(paying)

      assert.deepStrictEqual(proposal, { _tag: "SeatSold", seat: "A1", by: alice })
    }))

  it.effect("Pay on C6 is declined by the superstitious gateway", () =>
    Effect.gen(function*() {
      const paying = yield* Effect.forkChild(
        BoxOffice.actions.Pay({ _tag: "Pay", seat: "C6" }).pipe(Effect.provide(Stage))
      )
      yield* settle
      yield* TestClock.adjust("1100 millis")

      const proposal = yield* Fiber.join(paying)

      assert.deepStrictEqual(proposal, {
        _tag: "PaymentDeclined",
        seat: "C6",
        reason: "the gateway is superstitious about C6"
      })
    }))

  it.effect("Pay waits for the gateway before proposing", () =>
    Effect.gen(function*() {
      const paying = yield* Effect.forkChild(
        BoxOffice.actions.Pay({ _tag: "Pay", seat: "A1" }).pipe(Effect.provide(Stage))
      )
      yield* settle
      yield* TestClock.adjust("699 millis")

      assert.isUndefined(paying.pollUnsafe())
    }))

  it.effect("AwaitExpiry proposes a tick at the time it woke", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const waiting = yield* Effect.forkChild(
        BoxOffice.actions.AwaitExpiry({ _tag: "AwaitExpiry", until: 9_000 }).pipe(Effect.provide(Stage))
      )
      yield* settle
      yield* TestClock.adjust("8 seconds")

      const proposal = yield* Fiber.join(waiting)

      assert.deepStrictEqual(proposal, { _tag: "Ticked", now: 9_000 })
    }))

  it.effect("RaiseCurtain proposes the curtain at the clock", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(12_000)

      const proposal = yield* BoxOffice.actions.RaiseCurtain({ _tag: "RaiseCurtain" }).pipe(Effect.provide(Stage))

      assert.deepStrictEqual(proposal, { _tag: "CurtainRaised", at: 12_000 })
    }))
})
