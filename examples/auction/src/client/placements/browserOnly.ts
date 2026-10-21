import { layerLoopLocal } from "@mufw/core"
import { Layer } from "effect"
import { Auction } from "../../domain/Auction.ts"
import { layerCreditCheckPermissive } from "../../adapters/creditCheckPermissive.ts"
import { Ports } from "../../ports.ts"

/** Everything in the browser. No RPC. */
export const browserOnly = () => layerLoopLocal(Auction, Ports).pipe(Layer.provide(layerCreditCheckPermissive))
