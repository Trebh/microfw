import { Context } from "effect"
import type { Bidder } from "./Values.ts"

/**
 * Who is acting for the current intent. Port only: a server provides it per request from an
 * authenticated session, a page that runs its own actions provides it once (`src/adapters`), so an
 * intent never carries the identity it is placed under.
 */
export class CurrentBidder extends Context.Service<CurrentBidder, {
  readonly bidder: Bidder
}>()("auction/CurrentBidder") {}
