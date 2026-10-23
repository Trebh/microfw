import { Context, type Effect } from "effect"
import type { Patron, SeatId } from "./Values.ts"

/** What the gateway answers: a business outcome, not an error. */
export type Charge = { readonly _tag: "Charged" } | { readonly _tag: "Declined"; readonly reason: string }

/** Takes the money for a seat. Port only: the adapters live in `src/adapters`. */
export class PaymentGateway extends Context.Service<PaymentGateway, {
  charge(seat: SeatId, patron: Patron): Effect.Effect<Charge>
}>()("showcase/PaymentGateway") {}
