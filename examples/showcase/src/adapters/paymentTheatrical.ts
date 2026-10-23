import { Effect, Layer, Random } from "effect"
import { PaymentGateway } from "../domain/PaymentGateway.ts"

const SUPERSTITIOUS_SEAT = "C6"

/** The gateway thinks for a moment, then pays: only the delay is random, never the outcome. */
export const layerPaymentTheatrical = Layer.succeed(PaymentGateway, {
  charge: (seat) =>
    Random.nextIntBetween(700, 1100).pipe(
      Effect.flatMap((millis) => Effect.sleep(millis)),
      Effect.as(
        seat === SUPERSTITIOUS_SEAT
          ? { _tag: "Declined", reason: "the gateway is superstitious about C6" } as const
          : { _tag: "Charged" } as const
      )
    )
})
