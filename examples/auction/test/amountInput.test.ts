import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { parseAmount } from "../src/amountInput.ts"
import { Amount } from "../src/domain/Values.ts"

describe("parseAmount", () => {
  it("decodes a positive integer", () => {
    assert.deepStrictEqual(parseAmount("25"), Option.some(Amount.make(25)))
  })

  it("rejects an empty entry", () => {
    assert.deepStrictEqual(parseAmount(""), Option.none())
  })

  it("rejects an absent entry", () => {
    assert.deepStrictEqual(parseAmount(null), Option.none())
  })

  it("rejects text that is not a number", () => {
    assert.deepStrictEqual(parseAmount("abc"), Option.none())
  })

  it("rejects NaN", () => {
    assert.deepStrictEqual(parseAmount("NaN"), Option.none())
  })

  it("rejects a non-integer", () => {
    assert.deepStrictEqual(parseAmount("1.5"), Option.none())
  })

  it("rejects zero", () => {
    assert.deepStrictEqual(parseAmount("0"), Option.none())
  })

  it("rejects a negative number", () => {
    assert.deepStrictEqual(parseAmount("-3"), Option.none())
  })
})
