import { layerActionRunnerLocal, layerActionsDrain, layerIntentBus } from "@mufw/core"
import { Layer } from "effect"
import { Auction } from "../../domain/Auction.ts"
import { layerCreditCheckPermissive } from "../../adapters/creditCheckPermissive.ts"
import { Ports, Rpc } from "../../ports.ts"
import { transport } from "./transport.ts"

/**
 * Model on the server, actions in the browser: the server applies every proposal it receives.
 * Needs the server to serve `Present`, `Representations`, `History`.
 */
export const serverModel = () => {
  const remoteModel = Layer.merge(Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(Layer.provide(transport()))
  const localActions = layerActionRunnerLocal(Auction, Ports).pipe(Layer.provide(layerCreditCheckPermissive))
  return layerActionsDrain(Auction, Ports).pipe(
    Layer.provideMerge(Layer.merge(remoteModel, localActions)),
    Layer.provideMerge(layerIntentBus(Auction, Ports))
  )
}
