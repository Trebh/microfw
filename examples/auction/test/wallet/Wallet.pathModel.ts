import { assert } from "@effect/vitest"
import { createTestModel, type TestModelOptions } from "@mufw/test"
import { WalletPorts } from "../../src/ports.ts"
import { exploreWallet, serializeWallet } from "../../src/wallet/Wallet.explore.ts"
import { Wallet } from "../../src/wallet/Wallet.ts"

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

export const walletModel = createTestModel(Wallet, WalletPorts, walletTestModel)
