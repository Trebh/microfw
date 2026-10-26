import { Layer } from "effect"
import { layerAuthenticationAnonymous } from "../../authentication.ts"
import { Auction } from "../../auction/Auction.ts"
import { Rpc } from "../../ports.ts"
import { transport } from "./transport.ts"

/**
 * The server's `ModelPort` and nothing else, over the page's websocket: the same read as
 * `httpReadOnly`, with the connection state of `transport` unused. It sends no session, so the
 * server refuses any call that runs actions. Needs the server to serve `Representations`.
 */
export const socketReadOnly = Rpc.layerModelRemote.pipe(
  Layer.provide(transport(Auction, Rpc.layerClient.pipe(Layer.provide(layerAuthenticationAnonymous))))
)
