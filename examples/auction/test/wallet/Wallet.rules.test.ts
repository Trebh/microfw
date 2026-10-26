import { assert, describe, it } from "@effect/vitest"
import { acceptReserved, clearReservation, initial, state, Wallet } from "../../src/wallet/Wallet.ts"
import { held, reserved } from "./Wallet.fixtures.ts"

describe("acceptReserved", () => {
  it("holds the reserved amount", () => {
    assert.deepStrictEqual(acceptReserved(held(0), reserved(40)), { credit: 100, reserved: 40 })
  })

  it("replaces the previous hold instead of adding to it", () => {
    assert.deepStrictEqual(acceptReserved(held(40), reserved(60)), { credit: 100, reserved: 60 })
  })

  it("holds exactly the whole credit", () => {
    assert.deepStrictEqual(acceptReserved(held(0), reserved(100)), { credit: 100, reserved: 100 })
  })

  it("ignores an amount above the credit", () => {
    assert.deepStrictEqual(acceptReserved(held(40), reserved(101)), held(40))
  })
})

describe("clearReservation", () => {
  it("holds nothing", () => {
    assert.deepStrictEqual(clearReservation(held(40)), held(0))
  })
})

describe("state", () => {
  it("is funded with nothing held", () => {
    assert.deepStrictEqual(state(initial), { controlState: "funded", credit: 100, reserved: 0, available: 100 })
  })

  it("is funded while some credit is left", () => {
    assert.deepStrictEqual(state(held(99)), { controlState: "funded", credit: 100, reserved: 99, available: 1 })
  })

  it("is exhausted when the whole credit is held", () => {
    assert.deepStrictEqual(state(held(100)), { controlState: "exhausted", credit: 100, reserved: 100, available: 0 })
  })
})

describe("nap", () => {
  it("asks for nothing, whatever the state", () => {
    assert.deepStrictEqual(
      [Wallet.nap(state(held(0))), Wallet.nap(state(held(100)))],
      [[], []]
    )
  })
})
