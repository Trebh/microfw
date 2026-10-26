import { renderBehaviour } from "@mufw/test"
import { expect, it } from "vitest"
import { Auction } from "../../src/auction/Auction.ts"
import { auctionModel } from "./Auction.pathModel.ts"

it("the committed behaviour card matches the definition", async () => {
  const card = renderBehaviour(Auction, auctionModel.graph)

  await expect(card).toMatchFileSnapshot("../../src/auction/Auction.behaviour.md")
})
