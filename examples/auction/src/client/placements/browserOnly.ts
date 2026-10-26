import { layerLoopWith } from "@mufw/core"
import { Layer } from "effect"
import { layerWhoamiFixed } from "../../adapters/whoamiFixed.ts"
import { Auction } from "../../auction/Auction.ts"
import type { Bidder } from "../../domain/Values.ts"
import { Ports } from "../../ports.ts"
import { auctionActionRunnerLocal, auctionModelLocal } from "./auctionLocal.ts"

/** Everything in the browser, acting as `bidder`, which is also who the page says it is. No RPC. */
export const browserOnly = (bidder: Bidder) =>
  layerLoopWith(Auction, Ports, { model: auctionModelLocal(), runner: auctionActionRunnerLocal(bidder) }).pipe(
    Layer.provideMerge(layerWhoamiFixed(bidder))
  )
