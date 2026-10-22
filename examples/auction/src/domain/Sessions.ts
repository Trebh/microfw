import { Context, type Effect, type Option } from "effect"
import type { Bidder, SessionToken } from "./Values.ts"

/**
 * Who a session token belongs to; `none` for a token nobody holds. Port only: the server's table
 * is an adapter in `src/adapters`, so a page never ships the tokens.
 */
export class Sessions extends Context.Service<Sessions, {
  authenticate(token: SessionToken): Effect.Effect<Option.Option<Bidder>>
}>()("auction/Sessions") {}
