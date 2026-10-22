import { assert, describe, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { HttpServerOrigin } from "../src/client/serverOrigin.ts"

const decode = Schema.decodeUnknownOption(HttpServerOrigin)

describe("HttpServerOrigin", () => {
  it("reads a ws origin as its http one", () => {
    assert.deepStrictEqual(decode("ws://localhost:3001"), Option.some("http://localhost:3001"))
  })

  it("reads a wss origin as its https one", () => {
    assert.deepStrictEqual(decode("wss://auction.example"), Option.some("https://auction.example"))
  })

  it("refuses an origin that already says http", () => {
    assert.deepStrictEqual(decode("http://localhost:3001"), Option.none())
  })

  it("refuses an origin with a path", () => {
    assert.deepStrictEqual(decode("ws://localhost:3001/sam/auction"), Option.none())
  })
})
