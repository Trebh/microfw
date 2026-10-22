import { Schema } from "effect"

/** A sum of money in whole units: a positive integer. */
export const Amount = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)), Schema.brand("Amount"))
export type Amount = typeof Amount.Type

/** Who places a bid: a non-empty name. */
export const Bidder = Schema.NonEmptyString.pipe(Schema.brand("Bidder"))
export type Bidder = typeof Bidder.Type

/** What a client presents to prove who it is: an opaque, non-empty string the server looks up. */
export const SessionToken = Schema.NonEmptyString.pipe(Schema.brand("SessionToken"))
export type SessionToken = typeof SessionToken.Type
