import { layerActionsDrain, layerIntentBus, layerModelLocal } from "@mufw/core"
import { Layer } from "effect"
import { layerAuthenticationClient } from "../../authentication.ts"
import { Auction } from "../../domain/Auction.ts"
import type { SessionToken } from "../../domain/Values.ts"
import { Ports, Rpc } from "../../ports.ts"
import { transport } from "./transport.ts"

/** Model in the browser, actions on the server, which learns the bidder from `session`. Needs the server to serve `Dispatch`. */
export const serverActions = (session: SessionToken) => {
  const remoteActions = Rpc.layerActionRunnerRemote.pipe(
    Layer.provideMerge(transport(layerAuthenticationClient(session)))
  )
  return layerActionsDrain(Auction, Ports).pipe(
    Layer.provideMerge(Layer.merge(layerModelLocal(Auction, Ports), remoteActions)),
    Layer.provideMerge(layerIntentBus(Auction, Ports))
  )
}
