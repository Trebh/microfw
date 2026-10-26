import { makePorts } from "@mufw/core"
import { makeRpc, type RpcTag } from "@mufw/rpc"
import { Layer } from "effect"
import { Authentication } from "./authentication.ts"
import { Auction } from "./auction/Auction.ts"
import type { CurrentBidder } from "./domain/CurrentBidder.ts"
import { layerWhoamiHandlers, WhoamiRpcs } from "./whoami.ts"

/**
 * The ports of a server: `CurrentBidder` is per request, so whoever dispatches through them must
 * provide it. The `Authentication` middleware does, for every RPC that runs actions.
 */
export const ServerPorts = makePorts<typeof Auction, CurrentBidder>(Auction)

export const ServerRpc = makeRpc(Auction, ServerPorts, Authentication)

/**
 * What a server serves: the RPCs of `rpcs`, and `Whoami` whatever they are. `Whoami` is read-only
 * and tells a session only its own bidder, so it needs no deployment decision.
 */
export const serving = (rpcs: ReadonlyArray<RpcTag>) => ServerRpc.exposing(rpcs).merge(WhoamiRpcs)

/** The handlers of `serving`. */
export const layerServerHandlers = Layer.merge(ServerRpc.layerHandlers, layerWhoamiHandlers)
