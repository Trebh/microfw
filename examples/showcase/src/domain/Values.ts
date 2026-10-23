import { Schema } from "effect"

/** The house, in stage order: rows A to C, seats 1 to 6. */
export const SEAT_IDS = [
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "B1",
  "B2",
  "B3",
  "B4",
  "B5",
  "B6",
  "C1",
  "C2",
  "C3",
  "C4",
  "C5",
  "C6"
] as const

export const SeatId = Schema.Literals(SEAT_IDS)
export type SeatId = typeof SeatId.Type

/** Who holds or buys a seat: a non-empty name. */
export const Patron = Schema.NonEmptyString.pipe(Schema.brand("Patron"))
export type Patron = typeof Patron.Type
