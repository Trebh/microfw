import { AutoActions, layerLoopLocal } from "@mufw/core"
import { Effect, Layer } from "effect"
import { RpcTest } from "effect/rpc"
import { layerAuthenticationServer } from "../src/adapters/authenticationServer.ts"
import { layerCreditCheckTable } from "../src/adapters/creditCheckTable.ts"
import { layerSessionsTable } from "../src/adapters/sessionsTable.ts"
import type { layerAuthenticationAnonymous } from "../src/authentication.ts"
import { Auction } from "../src/auction/Auction.ts"
import { Whoami } from "../src/domain/Whoami.ts"
import { Rpc } from "../src/ports.ts"
import { layerServerHandlers, ServerPorts } from "../src/serverPorts.ts"
import { remoteWhoami, WhoamiRpcs } from "../src/whoami.ts"

/** What a server does: the bidder is not in the layer, the request's session provides it. */
const ServerLoop = layerLoopLocal(Auction, ServerPorts).pipe(
  Layer.provide(layerCreditCheckTable),
  Layer.provide(Layer.succeed(AutoActions, false))
)

export const Server = layerServerHandlers.pipe(
  Layer.provideMerge(layerAuthenticationServer.pipe(Layer.provide(layerSessionsTable))),
  Layer.provideMerge(ServerLoop)
)

/** The wire client, in-process, of `Server`; `authentication` decides what session it sends. */
export const clientWith = (authentication: typeof layerAuthenticationAnonymous) =>
  Rpc.layerClientTest.pipe(Layer.provide(authentication), Layer.provideMerge(Server))

/** `Whoami` as a page sees it, asked of `Server` in-process; `authentication` decides what session it sends. */
export const whoamiWith = (authentication: typeof layerAuthenticationAnonymous) =>
  Layer.effect(Whoami, Effect.map(RpcTest.makeClient(WhoamiRpcs), remoteWhoami)).pipe(
    Layer.provide(authentication),
    Layer.provide(Server)
  )
