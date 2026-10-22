import { AutoActions, layerLoopLocal } from "@mufw/core"
import { Layer } from "effect"
import { layerAuthenticationServer } from "../src/adapters/authenticationServer.ts"
import { layerCreditCheckTable } from "../src/adapters/creditCheckTable.ts"
import { layerSessionsTable } from "../src/adapters/sessionsTable.ts"
import type { layerAuthenticationAnonymous } from "../src/authentication.ts"
import { Auction } from "../src/domain/Auction.ts"
import { Rpc } from "../src/ports.ts"
import { ServerPorts, ServerRpc } from "../src/serverPorts.ts"

/** What a server does: the bidder is not in the layer, the request's session provides it. */
const ServerLoop = layerLoopLocal(Auction, ServerPorts).pipe(
  Layer.provide(layerCreditCheckTable),
  Layer.provide(Layer.succeed(AutoActions, false))
)

export const Server = ServerRpc.layerHandlers.pipe(
  Layer.provideMerge(layerAuthenticationServer.pipe(Layer.provide(layerSessionsTable))),
  Layer.provideMerge(ServerLoop)
)

/** The wire client, in-process, of `Server`; `authentication` decides what session it sends. */
export const clientWith = (authentication: typeof layerAuthenticationAnonymous) =>
  Rpc.layerClientTest.pipe(Layer.provide(authentication), Layer.provideMerge(Server))
