import { layerActionRunnerLocal, layerActionsDrain, layerIntentBus } from "@mufw/core"
import { Layer } from "effect"
import { layerCreditCheckPermissive } from "../../adapters/creditCheckPermissive.ts"
import { layerCurrentBidderFixed } from "../../adapters/currentBidderFixed.ts"
import { layerAuthenticationAnonymous } from "../../authentication.ts"
import { Auction } from "../../domain/Auction.ts"
import type { Bidder } from "../../domain/Values.ts"
import { Ports, Rpc } from "../../ports.ts"
import { transport } from "./transport.ts"

/**
 * Model on the server, actions in the browser, acting as `bidder`: the server applies every
 * proposal it receives. It calls no RPC that runs actions, so it sends no session. Needs the
 * server to serve `Present`, `Representations`, `History`.
 */
export const serverModel = (bidder: Bidder) => {
  const remoteModel = Layer.merge(Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(
    Layer.provideMerge(transport(layerAuthenticationAnonymous))
  )
  const localActions = layerActionRunnerLocal(Auction, Ports).pipe(
    Layer.provide(Layer.merge(layerCreditCheckPermissive, layerCurrentBidderFixed(bidder)))
  )
  return layerActionsDrain(Auction, Ports).pipe(
    Layer.provideMerge(Layer.merge(remoteModel, localActions)),
    Layer.provideMerge(layerIntentBus(Auction, Ports))
  )
}
