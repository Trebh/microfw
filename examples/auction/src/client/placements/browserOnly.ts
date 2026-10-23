import { layerActionsDrain, layerIntentBus } from "@mufw/core"
import { Layer } from "effect"
import { layerWhoamiFixed } from "../../adapters/whoamiFixed.ts"
import { Auction } from "../../domain/Auction.ts"
import type { Bidder } from "../../domain/Values.ts"
import { Ports } from "../../ports.ts"
import { auctionActionRunnerLocal, auctionModelLocal } from "./auctionLocal.ts"

/** Everything in the browser, acting as `bidder`, which is also who the page says it is. No RPC. */
export const browserOnly = (bidder: Bidder) =>
  layerActionsDrain(Auction, Ports).pipe(
    Layer.provideMerge(Layer.merge(auctionModelLocal(), auctionActionRunnerLocal(bidder))),
    Layer.provideMerge(layerIntentBus(Auction, Ports)),
    Layer.provideMerge(layerWhoamiFixed(bidder))
  )
