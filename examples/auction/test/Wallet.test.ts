import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { Amount } from "../src/domain/Values.ts"
import {
  acceptRefused,
  acceptReleased,
  acceptReserved,
  initial,
  type Model,
  nap,
  state,
  Wallet
} from "../src/domain/Wallet.ts"

const held = (reserved: number): Model => ({ credit: 100, reserved })

const reserved = (amount: number) => ({ _tag: "Reserved", amount: Amount.make(amount) }) as const
const refused = (amount: number) => ({ _tag: "Refused", amount: Amount.make(amount) }) as const
const released = { _tag: "Released" } as const

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

  it("ignores other proposals", () => {
    assert.deepStrictEqual(acceptReserved(held(40), released), held(40))
  })
})

describe("acceptReleased", () => {
  it("holds nothing", () => {
    assert.deepStrictEqual(acceptReleased(held(40), released), held(0))
  })

  it("ignores other proposals", () => {
    assert.deepStrictEqual(acceptReleased(held(40), reserved(60)), held(40))
  })
})

describe("acceptRefused", () => {
  it("drops the hold of the bid it replaces", () => {
    assert.deepStrictEqual(acceptRefused(held(40), refused(150)), held(0))
  })

  it("ignores other proposals", () => {
    assert.deepStrictEqual(acceptRefused(held(40), reserved(60)), held(40))
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
    assert.deepStrictEqual([nap(state(held(0))), nap(state(held(100)))], [Option.none(), Option.none()])
  })
})

describe("Reserve action", () => {
  it.effect("answers Reserved for an amount within the credit", () =>
    Effect.gen(function*() {
      const proposal = yield* Wallet.actions.Reserve({ _tag: "Reserve", amount: Amount.make(100) })

      assert.deepStrictEqual(proposal, reserved(100))
    }))

  it.effect("answers Refused for an amount above the credit", () =>
    Effect.gen(function*() {
      const proposal = yield* Wallet.actions.Reserve({ _tag: "Reserve", amount: Amount.make(101) })

      assert.deepStrictEqual(proposal, refused(101))
    }))
})

describe("Release action", () => {
  it.effect("answers Released", () =>
    Effect.gen(function*() {
      const proposal = yield* Wallet.actions.Release({ _tag: "Release" })

      assert.deepStrictEqual(proposal, released)
    }))
})
