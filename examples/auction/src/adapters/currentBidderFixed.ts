import { Layer } from "effect"
import { CurrentBidder } from "../domain/CurrentBidder.ts"
import type { Bidder } from "../domain/Values.ts"

/**
 * One identity for the whole page. For a page that runs its own actions: the browser is the only
 * party that could vouch for the bidder, and in those placements it is already trusted with
 * everything else (the server applies any proposal it presents).
 */
export const layerCurrentBidderFixed = (bidder: Bidder) => Layer.succeed(CurrentBidder, { bidder })
