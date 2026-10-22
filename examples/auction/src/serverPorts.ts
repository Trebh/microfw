import { makePorts } from "@mufw/core"
import { makeRpc } from "@mufw/rpc"
import { Authentication } from "./authentication.ts"
import { Auction } from "./domain/Auction.ts"
import type { CurrentBidder } from "./domain/CurrentBidder.ts"

/**
 * The ports of a server: `CurrentBidder` is per request, so whoever dispatches through them must
 * provide it. The `Authentication` middleware does, for every RPC that runs actions.
 */
export const ServerPorts = makePorts<typeof Auction, CurrentBidder>(Auction)

export const ServerRpc = makeRpc(Auction, ServerPorts, Authentication)
