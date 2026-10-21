import { layerActionsDrain, layerIntentBus, layerModelLocal } from "@mufw/core"
import { Layer } from "effect"
import { Auction } from "../../domain/Auction.ts"
import { Ports, Rpc } from "../../ports.ts"
import { transport } from "./transport.ts"

/** Model in the browser, actions on the server. Needs the server to serve `Dispatch`. */
export const serverActions = () => {
  const remoteActions = Rpc.layerActionRunnerRemote.pipe(Layer.provide(transport()))
  return layerActionsDrain(Auction, Ports).pipe(
    Layer.provideMerge(Layer.merge(layerModelLocal(Auction, Ports), remoteActions)),
    Layer.provideMerge(layerIntentBus(Auction, Ports))
  )
}
