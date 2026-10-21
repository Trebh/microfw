import { Effect, Layer } from "effect"
import { CreditCheck } from "../domain/CreditCheck.ts"

const LIMITS: Record<string, number> = { alice: 100, bob: 1000 }
const DEFAULT_LIMIT = 50

/** The server's credit limits: the secret a placement with browser-side actions cannot enforce. */
export const layerCreditCheckTable = Layer.succeed(CreditCheck, {
  limit: (bidder) => Effect.succeed(LIMITS[bidder] ?? DEFAULT_LIMIT)
})
