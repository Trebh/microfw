import { Layer } from "effect"
import { layerAuthenticationClient } from "../../authentication.ts"
import { Auction } from "../../domain/Auction.ts"
import type { SessionToken } from "../../domain/Values.ts"
import { Rpc } from "../../ports.ts"
import { transport } from "./transport.ts"

/**
 * The server owns model and actions and learns the bidder from `session`; the browser submits
 * intents and streams representations.
 * Needs the server to serve `Submit`, `Representations`, `History` (and `TravelTo` for the panel).
 */
export const serverOwned = (session: SessionToken) =>
  Layer.mergeAll(Rpc.layerIntentPortRemote, Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(
    Layer.provideMerge(transport(Auction, Rpc.layerClient.pipe(Layer.provide(layerAuthenticationClient(session)))))
  )
