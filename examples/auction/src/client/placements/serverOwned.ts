import { Layer } from "effect"
import { layerAuthenticationClient } from "../../authentication.ts"
import { Auction } from "../../domain/Auction.ts"
import type { SessionToken } from "../../domain/Values.ts"
import { Rpc } from "../../ports.ts"
import { layerWhoamiRemote } from "../../whoami.ts"
import { transport } from "./transport.ts"

/**
 * The server owns model and actions and learns the bidder from `session`; the browser submits
 * intents and streams representations, and asks the server whose the session is (`Whoami`).
 * Needs the server to serve `Submit`, `Representations`, `History` (and `TravelTo` for the panel);
 * it serves `Whoami` always.
 */
export const serverOwned = (session: SessionToken) => {
  const client = Layer.merge(Rpc.layerClient, layerWhoamiRemote).pipe(Layer.provide(layerAuthenticationClient(session)))
  return Layer.mergeAll(Rpc.layerIntentPortRemote, Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(
    Layer.provideMerge(transport(Auction, client))
  )
}
