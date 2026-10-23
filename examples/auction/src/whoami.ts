import { Unauthenticated } from "@mufw/rpc"
import { Effect, Layer } from "effect"
import { Rpc, RpcClient, type RpcClientError, RpcGroup } from "effect/rpc"
import { Authentication } from "./authentication.ts"
import { CurrentBidder } from "./domain/CurrentBidder.ts"
import { Bidder } from "./domain/Values.ts"
import { Whoami } from "./domain/Whoami.ts"

/**
 * The session's bidder. It is the auction's own identity, not part of the generic contract of
 * `@mufw/rpc`, and it sits behind `Authentication` like the RPCs that run actions: the answer is
 * whatever the middleware provided as `CurrentBidder`.
 */
export const WhoamiRpcs = RpcGroup.make(
  Rpc.make("Whoami", { success: Bidder, error: Unauthenticated }).middleware(Authentication)
)

export type WhoamiClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof WhoamiRpcs>, RpcClientError.RpcClientError>

export const layerWhoamiHandlers = WhoamiRpcs.toLayer({
  Whoami: () => CurrentBidder.useSync((current) => current.bidder)
})

/** A call that finds the transport lost is not an identity outcome; it surfaces as a defect. */
export const remoteWhoami = (client: WhoamiClient): Whoami["Service"] => ({
  bidder: client.Whoami().pipe(Effect.catchTag("RpcClientError", Effect.die))
})

/** Asks the server whose the session is; needs a client protocol and the client half of `Authentication`. */
export const layerWhoamiRemote = Layer.effect(Whoami, Effect.map(RpcClient.make(WhoamiRpcs), remoteWhoami))
