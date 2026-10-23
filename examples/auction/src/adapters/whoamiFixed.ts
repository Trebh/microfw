import { Effect, Layer } from "effect"
import { Whoami } from "../domain/Whoami.ts"
import type { Bidder } from "../domain/Values.ts"

/**
 * The page's own bidder, for a page that runs its own actions: the browser is the only party that
 * could vouch for it, and in those placements it is already trusted with everything else.
 */
export const layerWhoamiFixed = (bidder: Bidder) => Layer.succeed(Whoami, { bidder: Effect.succeed(bidder) })
