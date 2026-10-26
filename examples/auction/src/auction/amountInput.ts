import { Option, Schema } from "effect"
import { Amount } from "../domain/Values.ts"

const AmountFromString = Schema.NumberFromString.pipe(Schema.decodeTo(Amount))

/** Decodes a bid form's `amount` entry; anything that is not a positive integer is `None`, so it never becomes an intent. */
export const parseAmount: (entry: unknown) => Option.Option<Amount> = Schema.decodeUnknownOption(AmountFromString)
