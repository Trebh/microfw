import { assert } from "@effect/vitest"
import type { TestModelOptions } from "@mufw/test"
import { exploreWallet, serializeWallet, type Wallet } from "../src/domain/Wallet.ts"

/** The wallet's test model: exploration alphabet plus one assertion per control state. */
export const walletTestModel: TestModelOptions<typeof Wallet> = {
  explore: exploreWallet,
  serialize: serializeWallet,
  states: {
    funded: (representation) => {
      assert.strictEqual(representation.controlState, "funded")
      assert.ok(representation.available > 0, `${representation.available} available`)
    },
    exhausted: (representation) => {
      assert.strictEqual(representation.available, 0)
      assert.strictEqual(representation.reserved, representation.credit)
    }
  }
}
