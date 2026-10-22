import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { initial, type Representation, state } from "../src/domain/Auction.ts"
import { Amount, Bidder } from "../src/domain/Values.ts"
import { holdForBids } from "../src/domain/WalletFeed.ts"

const alice = Bidder.make("alice")
const bob = Bidder.make("bob")
const forward = holdForBids(alice)

const noBid: Representation = { ...state(initial), controlState: "open", remainingSeconds: 50 }

const leading = (bidder: Bidder, amount: number, remainingSeconds = 50): Representation => ({
  ...noBid,
  remainingSeconds,
  highest: Option.some({ bidder, amount: Amount.make(amount), at: 0 })
})

const reserve = (amount: number) => Option.some({ _tag: "Reserve", amount: Amount.make(amount) } as const)
const release = Option.some({ _tag: "Release" } as const)

describe("holdForBids", () => {
  it("reserves the leading bid of the page's bidder", () => {
    assert.deepStrictEqual(forward(Option.some(noBid), leading(alice, 40)), reserve(40))
  })

  it("reserves a leading bid that is already there when the page loads", () => {
    assert.deepStrictEqual(forward(Option.none(), leading(alice, 40)), reserve(40))
  })

  it("reserves the new amount when the bidder raises their own bid", () => {
    assert.deepStrictEqual(forward(Option.some(leading(alice, 40)), leading(alice, 50)), reserve(50))
  })

  it("releases when another bidder takes the lead", () => {
    assert.deepStrictEqual(forward(Option.some(leading(alice, 40)), leading(bob, 45)), release)
  })

  it("asks nothing for a first representation without a bid, since a wallet starts released", () => {
    assert.deepStrictEqual(forward(Option.none(), noBid), Option.none())
  })

  it("asks nothing when only the clock moved", () => {
    assert.deepStrictEqual(forward(Option.some(leading(alice, 40, 50)), leading(alice, 40, 49)), Option.none())
  })

  it("asks nothing while another bidder keeps the lead", () => {
    assert.deepStrictEqual(forward(Option.some(leading(bob, 45)), leading(bob, 50)), Option.none())
  })

  it("asks nothing for a first representation led by another bidder", () => {
    assert.deepStrictEqual(forward(Option.none(), leading(bob, 45)), Option.none())
  })
})
