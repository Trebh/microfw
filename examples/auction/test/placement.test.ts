import { assert, describe, it } from "@effect/vitest"
import { Bidder, SessionToken } from "../src/domain/Values.ts"
import {
  describeIdentity,
  formatPlacement,
  parseBidder,
  parsePlacement,
  parseSession
} from "../src/client/placement.ts"

describe("parsePlacement", () => {
  it("is client/client without a query", () => {
    assert.deepStrictEqual(parsePlacement(""), { model: "client", actions: "client" })
  })

  it("is client/client for an empty placement", () => {
    assert.deepStrictEqual(parsePlacement("?placement="), { model: "client", actions: "client" })
  })

  it("reads both sides", () => {
    assert.deepStrictEqual(parsePlacement("?placement=model:server,actions:client"), {
      model: "server",
      actions: "client"
    })
  })

  it("reads the sides in any order", () => {
    assert.deepStrictEqual(parsePlacement("?placement=actions:server,model:client"), {
      model: "client",
      actions: "server"
    })
  })

  it("takes a missing side as client", () => {
    assert.deepStrictEqual(parsePlacement("?placement=actions:server"), { model: "client", actions: "server" })
  })

  it("falls back to client/client for an unknown side", () => {
    assert.deepStrictEqual(parsePlacement("?placement=model:server,actions:cloud"), {
      model: "client",
      actions: "client"
    })
  })

  it("ignores the bidder parameter", () => {
    assert.deepStrictEqual(parsePlacement("?bidder=bob&placement=model:server"), { model: "server", actions: "client" })
  })

  it("round-trips an asymmetric placement through formatPlacement", () => {
    const search = `?placement=${formatPlacement({ model: "server", actions: "client" })}`

    assert.deepStrictEqual(parsePlacement(search), { model: "server", actions: "client" })
  })

  it("formats the model side before the actions side", () => {
    assert.strictEqual(formatPlacement({ model: "server", actions: "client" }), "model:server,actions:client")
  })
})

describe("parseBidder", () => {
  it("is alice without a query", () => {
    assert.strictEqual(parseBidder(""), Bidder.make("alice"))
  })

  it("reads the bidder", () => {
    assert.strictEqual(parseBidder("?bidder=bob"), Bidder.make("bob"))
  })

  it("falls back to alice for an empty bidder", () => {
    assert.strictEqual(parseBidder("?bidder="), Bidder.make("alice"))
  })

  it("ignores the placement parameter", () => {
    assert.strictEqual(parseBidder("?placement=model:server&bidder=bob"), Bidder.make("bob"))
  })
})

describe("parseSession", () => {
  it("is demo-alice without a query", () => {
    assert.strictEqual(parseSession(""), SessionToken.make("demo-alice"))
  })

  it("reads the session", () => {
    assert.strictEqual(parseSession("?session=demo-bob"), SessionToken.make("demo-bob"))
  })

  it("falls back to demo-alice for an empty session", () => {
    assert.strictEqual(parseSession("?session="), SessionToken.make("demo-alice"))
  })

  it("ignores the bidder parameter", () => {
    assert.strictEqual(parseSession("?bidder=bob"), SessionToken.make("demo-alice"))
  })
})

describe("describeIdentity", () => {
  const identity = { bidder: Bidder.make("bob"), session: SessionToken.make("demo-carol") }

  it("names the session where the server runs the actions", () => {
    assert.strictEqual(describeIdentity("server", identity), "session demo-carol")
  })

  it("names the bidder where the browser runs the actions", () => {
    assert.strictEqual(describeIdentity("client", identity), "bidder bob")
  })
})
