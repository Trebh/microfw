import { Unauthenticated } from "@mufw/rpc"
import { Headers } from "effect/http"
import { RpcMiddleware } from "effect/rpc"
import type { CurrentBidder } from "./domain/CurrentBidder.ts"
import type { SessionToken } from "./domain/Values.ts"

/** The request header that carries the session token; a browser websocket cannot set headers, an RPC request can. */
export const SESSION_HEADER = "x-session-token"

/**
 * Authenticates the RPCs that run actions and provides `CurrentBidder` to them. The server's
 * implementation is `layerAuthenticationServer`; `requiredForClient` makes every client choose
 * how it sends its session (or that it sends none).
 */
export class Authentication extends RpcMiddleware.Service<Authentication, { provides: CurrentBidder }>()(
  "auction/Authentication",
  { error: Unauthenticated, requiredForClient: true }
) {}

/** Sends the session token with every request. */
export const layerAuthenticationClient = (token: SessionToken) =>
  RpcMiddleware.layerClient(Authentication, ({ next, request }) =>
    next({ ...request, headers: Headers.set(request.headers, SESSION_HEADER, token) }))

/** For a client that calls no RPC which runs actions: it sends nothing, so such a call is refused. */
export const layerAuthenticationAnonymous = RpcMiddleware.layerClient(Authentication, ({ next, request }) =>
  next(request))
