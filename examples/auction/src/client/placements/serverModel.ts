import { layerLoopWith } from "@mufw/core"
import { Layer } from "effect"
import { layerWhoamiFixed } from "../../adapters/whoamiFixed.ts"
import { layerAuthenticationAnonymous } from "../../authentication.ts"
import { Auction } from "../../auction/Auction.ts"
import type { Bidder } from "../../domain/Values.ts"
import { Ports, Rpc } from "../../ports.ts"
import { auctionActionRunnerLocal } from "./auctionLocal.ts"
import { transport } from "./transport.ts"

/**
 * Model on the server, actions in the browser, acting as `bidder`: the server applies every
 * proposal it receives. It calls no RPC that runs actions, so it sends no session, and `bidder` is
 * also who the page says it is. Needs the server to serve `Present`, `Representations`, `History`.
 */
export const serverModel = (bidder: Bidder) => {
  const client = Rpc.layerClient.pipe(Layer.provide(layerAuthenticationAnonymous))
  const remoteModel = Layer.merge(Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(
    Layer.provideMerge(transport(Auction, client))
  )
  return layerLoopWith(Auction, Ports, { model: remoteModel, runner: auctionActionRunnerLocal(bidder) }).pipe(
    Layer.provideMerge(layerWhoamiFixed(bidder))
  )
}
