import type { Explore } from "@mufw/core"
import { Option } from "effect"
import type { BoxOffice } from "./BoxOffice.ts"
import type { Model, Proposal, Representation, SeatView } from "./BoxOffice.ts"
import { Patron } from "./Values.ts"

const guest = Patron.make("guest")

const firstSeat = (representation: Representation, status: SeatView["status"]): Option.Option<SeatView> =>
  Option.fromNullishOr(representation.seats.find((seat) => seat.status === status))

const holdProposals = (representation: Representation, model: Model): ReadonlyArray<Proposal> => {
  if (representation.sold > 0) return []
  const hold = (seat: SeatView) => ({ _tag: "SeatHeld", seat: seat.id, by: guest, at: model.now }) as const
  return Option.toArray(Option.map(firstSeat(representation, "free"), hold))
}

const saleProposals = (representation: Representation): ReadonlyArray<Proposal> => {
  if (representation.sold > 0) return []
  const sell = (seat: SeatView) => Option.map(seat.by, (by) => ({ _tag: "SeatSold", seat: seat.id, by }) as const)
  return Option.toArray(Option.flatMap(firstSeat(representation, "held"), sell))
}

const tickProposals = (representation: Representation): ReadonlyArray<Proposal> => {
  const tickTo = (until: number) => ({ _tag: "Ticked", now: until }) as const
  const deadlines = representation.seats.flatMap((seat) => Option.toArray(seat.heldUntil))
  const earliestHold = deadlines.length === 0 ? Option.none() : Option.some(Math.min(...deadlines))
  return Option.toArray(Option.map(earliestHold, tickTo))
}

/**
 * Holds fill the house one seat at a time, which is the only way to reach `full`; sales, expiries
 * and the curtain are sampled while at most one seat is taken and once the house is full, so the
 * explored states stay a chain with a few side exits.
 */
export const exploreBoxOffice: Explore<typeof BoxOffice> = (representation, model) => {
  if (representation.controlState === "dark") return [{ _tag: "DoorsOpened", at: model.now }]
  if (representation.controlState === "curtain") return []
  const holds = holdProposals(representation, model)
  const hasExits = representation.held + representation.sold <= 1 || representation.free === 0
  if (!hasExits) return holds
  return [
    ...holds,
    ...saleProposals(representation),
    ...tickProposals(representation),
    { _tag: "CurtainRaised", at: model.now }
  ]
}

/** Seats taken and seats free matter to what a state enables; the clock and who holds what do not. */
export const serializeBoxOffice = (representation: Representation) =>
  `${representation.controlState}:${representation.free}:${representation.held > 0}:${representation.sold > 0}`
