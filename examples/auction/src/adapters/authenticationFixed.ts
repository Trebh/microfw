import { Effect, Layer } from "effect"
import { Authentication } from "../authentication.ts"
import { CurrentBidder } from "../domain/CurrentBidder.ts"
import type { Bidder } from "../domain/Values.ts"

/**
 * The `Authentication` of a worker the page started: the only client it will ever have is that
 * page, which names its own bidder when it starts the worker, so every request acts as `bidder` and
 * no credential is read. It trusts nothing a network server could receive: only a worker's entry
 * point imports it, and the server keeps `layerAuthenticationServer`.
 */
export const layerAuthenticationFixed = (bidder: Bidder) =>
  Layer.succeed(Authentication, (handler) => Effect.provideService(handler, CurrentBidder, { bidder }))
