import { Context, type Effect } from "effect"
import type { Bidder } from "./Values.ts"

/** How much a bidder may bid. Port only: the adapters live in `src/adapters`, so a page never ships the server's table. */
export class CreditCheck extends Context.Service<CreditCheck, {
  limit(bidder: Bidder): Effect.Effect<number>
}>()("auction/CreditCheck") {}
