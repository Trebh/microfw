import { renderBehaviour } from "@mufw/test"
import { expect, it } from "vitest"
import { Wallet } from "../../src/wallet/Wallet.ts"
import { walletModel } from "./Wallet.pathModel.ts"

it("the committed behaviour card matches the definition", async () => {
  const card = renderBehaviour(Wallet, walletModel.graph)

  await expect(card).toMatchFileSnapshot("../../src/wallet/Wallet.behaviour.md")
})
