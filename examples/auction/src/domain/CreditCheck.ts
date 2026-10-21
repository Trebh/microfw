import { Context, Effect, Layer } from "effect"

/** How much a bidder may bid. The live table is a server secret. */
export class CreditCheck extends Context.Service<CreditCheck, {
  limit(bidder: string): Effect.Effect<number>
}>()("auction/CreditCheck") {
  static readonly layerLive = Layer.succeed(CreditCheck, {
    limit: (bidder) => Effect.succeed(LIMITS[bidder] ?? DEFAULT_LIMIT)
  })

  /** What a client can at best fake: no limit at all. */
  static readonly layerPermissive = Layer.succeed(CreditCheck, {
    limit: () => Effect.succeed(Number.MAX_SAFE_INTEGER)
  })
}

const LIMITS: Record<string, number> = { alice: 100, bob: 1000 }
const DEFAULT_LIMIT = 50
