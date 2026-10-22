import { Layer } from "effect"
import { layerAuthenticationAnonymous } from "../../authentication.ts"
import { Auction } from "../../domain/Auction.ts"
import { Rpc } from "../../ports.ts"
import { transport } from "./transport.ts"

/**
 * The server's history and nothing else: no model, no intents, no actions. It sends no session, so
 * the server refuses any call that runs actions; `History` is not one of them.
 * Needs the server to serve `History`.
 */
export const historyOnly = Rpc.layerHistoryRemote.pipe(
  Layer.provideMerge(transport(Auction, Rpc.layerClient.pipe(Layer.provide(layerAuthenticationAnonymous))))
)
