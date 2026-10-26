import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Amount } from "../../src/domain/Values.ts"
import { Wallet } from "../../src/wallet/Wallet.ts"
import { refused, released, reserved } from "./Wallet.fixtures.ts"

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
