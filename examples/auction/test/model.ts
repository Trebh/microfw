import assert from "node:assert/strict"
import type { TestModelOptions } from "@mufw/test"
import { type Auction, exploreAuction, serializeAuction } from "../src/domain/Auction.ts"

/** The auction's test model: exploration alphabet plus one assertion per control state. */
export const auctionTestModel: TestModelOptions<typeof Auction> = {
  explore: exploreAuction,
  serialize: serializeAuction,
  states: {
    open: (representation) => {
      assert.ok(representation.remainingSeconds > 10, `${representation.remainingSeconds}s left`)
      assert.strictEqual(representation.controlState, "open")
    },
    closing: (representation) => {
      assert.ok(representation.remainingSeconds <= 10, `${representation.remainingSeconds}s left`)
    },
    sold: (representation) => {
      assert.strictEqual(representation.remainingSeconds, 0)
      assert.strictEqual(representation.controlState, "sold")
    }
  }
}
