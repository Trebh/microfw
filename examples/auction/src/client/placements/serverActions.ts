import { layerActionsDrain, layerIntentBus } from "@mufw/core"
import { Layer } from "effect"
import { layerAuthenticationClient } from "../../authentication.ts"
import { Auction } from "../../domain/Auction.ts"
import type { SessionToken } from "../../domain/Values.ts"
import { Ports, Rpc } from "../../ports.ts"
import { layerWhoamiRemote } from "../../whoami.ts"
import { auctionModelLocal } from "./auctionLocal.ts"
import { transport } from "./transport.ts"

/**
 * Model in the browser, actions on the server, which learns the bidder from `session` and tells it
 * back (`Whoami`). Needs the server to serve `Dispatch`; it serves `Whoami` always.
 */
export const serverActions = (session: SessionToken) => {
  const client = Layer.merge(Rpc.layerClient, layerWhoamiRemote).pipe(Layer.provide(layerAuthenticationClient(session)))
  const remoteActions = Rpc.layerActionRunnerRemote.pipe(Layer.provideMerge(transport(Auction, client)))
  return layerActionsDrain(Auction, Ports).pipe(
    Layer.provideMerge(Layer.merge(auctionModelLocal(), remoteActions)),
    Layer.provideMerge(layerIntentBus(Auction, Ports))
  )
}
