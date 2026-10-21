import { Effect, Layer } from "effect"
import { CreditCheck } from "../domain/CreditCheck.ts"

/** What a browser can at best provide: no limit at all. */
export const layerCreditCheckPermissive = Layer.succeed(CreditCheck, {
  limit: () => Effect.succeed(Number.MAX_SAFE_INTEGER)
})
