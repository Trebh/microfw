import { layerLoopLocal } from "@mufw/core"
import { Layer } from "effect"
import { layerCreditCheckPermissive } from "../../adapters/creditCheckPermissive.ts"
import { layerCurrentBidderFixed } from "../../adapters/currentBidderFixed.ts"
import { Auction } from "../../domain/Auction.ts"
import type { Bidder } from "../../domain/Values.ts"
import { Ports } from "../../ports.ts"

/** Everything in the browser, acting as `bidder`. No RPC. */
export const browserOnly = (bidder: Bidder) =>
  layerLoopLocal(Auction, Ports).pipe(
    Layer.provide(Layer.merge(layerCreditCheckPermissive, layerCurrentBidderFixed(bidder)))
  )
