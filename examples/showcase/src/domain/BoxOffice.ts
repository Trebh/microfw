import { define, type Explore, makePorts } from "@mufw/core"
import { Clock, Effect, Option, Schema } from "effect"
import { CurrentPatron } from "./CurrentPatron.ts"
import { PaymentGateway } from "./PaymentGateway.ts"
import { Patron, SEAT_IDS, SeatId } from "./Values.ts"

export { Patron, SEAT_IDS, SeatId }

/** How long a held seat waits for its payment. */
export const HOLD_MILLIS = 8000

const Free = Schema.TaggedStruct("Free", { seat: SeatId })
const Held = Schema.TaggedStruct("Held", { seat: SeatId, by: Patron, until: Schema.Number })
const Sold = Schema.TaggedStruct("Sold", { seat: SeatId, by: Patron })

export const Place = Schema.Union([Free, Held, Sold])
export type Place = typeof Place.Type

export const Model = Schema.Struct({
  phase: Schema.Literals(["dark", "selling", "curtain"]),
  now: Schema.Number,
  seats: Schema.Array(Place),
  lastRefusal: Schema.Option(Schema.String)
})
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("DoorsOpened", { at: Schema.Number }),
  Schema.TaggedStruct("SeatHeld", { seat: SeatId, by: Patron, at: Schema.Number }),
  Schema.TaggedStruct("SeatSold", { seat: SeatId, by: Patron }),
  Schema.TaggedStruct("PaymentDeclined", { seat: SeatId, reason: Schema.String }),
  Schema.TaggedStruct("Tick", { now: Schema.Number }),
  Schema.TaggedStruct("CurtainUp", { at: Schema.Number })
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("OpenDoors", {}),
  Schema.TaggedStruct("Hold", { seat: SeatId }),
  Schema.TaggedStruct("Pay", { seat: SeatId }),
  Schema.TaggedStruct("AwaitExpiry", { until: Schema.Number }),
  Schema.TaggedStruct("RaiseCurtain", {})
])
export type Intent = typeof Intent.Type

export const SeatView = Schema.Struct({
  id: SeatId,
  status: Schema.Literals(["free", "held", "sold"]),
  by: Schema.Option(Patron),
  heldUntil: Schema.Option(Schema.Number)
})
export type SeatView = typeof SeatView.Type

export const Representation = Schema.Struct({
  controlState: Schema.Literals(["dark", "selling", "full", "curtain"]),
  seats: Schema.Array(SeatView),
  now: Schema.Number,
  lastRefusal: Schema.Option(Schema.String),
  free: Schema.Int,
  held: Schema.Int,
  sold: Schema.Int
})
export type Representation = typeof Representation.Type

/** The doors are closed until `DoorsOpened`: the clock belongs to the environment, not the module. */
export const initial: Model = {
  phase: "dark",
  now: 0,
  seats: SEAT_IDS.map((seat) => ({ _tag: "Free", seat }) as const),
  lastRefusal: Option.none()
}

const placeOf = (model: Model, seat: SeatId): Option.Option<Place> =>
  Option.fromNullishOr(model.seats.find((place) => place.seat === seat))

const withPlace = (model: Model, replacement: Place): Model => ({
  ...model,
  seats: model.seats.map((place) => (place.seat === replacement.seat ? replacement : place))
})

const refuse = (model: Model, reason: string): Model => ({ ...model, lastRefusal: Option.some(reason) })

const closedReason = (model: Model): Option.Option<string> => {
  if (model.phase === "dark") return Option.some("the doors are not open yet")
  if (model.phase === "curtain") return Option.some("the curtain is up")
  return Option.none()
}

export const acceptDoorsOpened = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "DoorsOpened" && model.phase === "dark" ? { ...model, phase: "selling", now: proposal.at } : model

export const acceptSeatHeld = (model: Model, proposal: Proposal): Model => {
  if (proposal._tag !== "SeatHeld") return model
  const closed = closedReason(model)
  if (Option.isSome(closed)) return refuse(model, closed.value)
  const place = placeOf(model, proposal.seat)
  if (!Option.exists(place, (found) => found._tag === "Free")) return refuse(model, `${proposal.seat} is taken`)
  const held: Place = { _tag: "Held", seat: proposal.seat, by: proposal.by, until: proposal.at + HOLD_MILLIS }
  return {
    ...withPlace(model, held),
    now: Math.max(model.now, proposal.at),
    lastRefusal: Option.none()
  }
}

export const acceptSeatSold = (model: Model, proposal: Proposal): Model => {
  if (proposal._tag !== "SeatSold") return model
  const closed = closedReason(model)
  if (Option.isSome(closed)) return refuse(model, closed.value)
  const heldByBuyer = Option.exists(
    placeOf(model, proposal.seat),
    (found) => found._tag === "Held" && found.by === proposal.by
  )
  if (!heldByBuyer) return refuse(model, `${proposal.seat} is not held for ${proposal.by}`)
  const sold: Place = { _tag: "Sold", seat: proposal.seat, by: proposal.by }
  return { ...withPlace(model, sold), lastRefusal: Option.none() }
}

export const acceptPaymentDeclined = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "PaymentDeclined" ? refuse(model, `${proposal.seat} was declined: ${proposal.reason}`) : model

export const acceptTick = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "Tick" && model.phase !== "dark" ? { ...model, now: Math.max(model.now, proposal.now) } : model

const release = (place: Place): Place => (place._tag === "Held" ? { _tag: "Free", seat: place.seat } : place)

/** The curtain rising lets go of every hold: nobody can pay once it is up. */
export const acceptCurtainUp = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "CurtainUp" && model.phase === "selling"
    ? { ...model, phase: "curtain", now: Math.max(model.now, proposal.at), seats: model.seats.map(release) }
    : model

/** Frees every hold whose time is up, after whatever proposal moved the clock. */
export const releaseExpiredHolds = (model: Model): Model => {
  const isExpired = (place: Place) => place._tag === "Held" && place.until <= model.now
  if (!model.seats.some(isExpired)) return model
  return { ...model, seats: model.seats.map((place) => (isExpired(place) ? release(place) : place)) }
}

const seatView = (place: Place): SeatView => {
  switch (place._tag) {
    case "Free":
      return { id: place.seat, status: "free", by: Option.none(), heldUntil: Option.none() }
    case "Held":
      return { id: place.seat, status: "held", by: Option.some(place.by), heldUntil: Option.some(place.until) }
    case "Sold":
      return { id: place.seat, status: "sold", by: Option.some(place.by), heldUntil: Option.none() }
  }
}

const countOf = (seats: ReadonlyArray<SeatView>, status: SeatView["status"]): number =>
  seats.filter((seat) => seat.status === status).length

const controlStateOf = (model: Model, free: number): Representation["controlState"] => {
  if (model.phase !== "selling") return model.phase
  return free === 0 ? "full" : "selling"
}

export const state = (model: Model): Representation => {
  const seats = model.seats.map(seatView)
  const free = countOf(seats, "free")
  return {
    controlState: controlStateOf(model, free),
    seats,
    now: model.now,
    lastRefusal: model.lastRefusal,
    free,
    held: countOf(seats, "held"),
    sold: countOf(seats, "sold")
  }
}

const earliestHold = (representation: Representation): Option.Option<number> => {
  const deadlines = representation.seats.flatMap((seat) => Option.toArray(seat.heldUntil))
  return deadlines.length === 0 ? Option.none() : Option.some(Math.min(...deadlines))
}

/** Waits for the earliest hold only: a hold made later expires later, so one wait is enough at a time. */
export const nap = (representation: Representation): Option.Option<Intent> => {
  if (representation.controlState === "dark" || representation.controlState === "curtain") return Option.none()
  if (representation.sold === representation.seats.length) return Option.some({ _tag: "RaiseCurtain" })
  return Option.map(earliestHold(representation), (until) => ({ _tag: "AwaitExpiry", until }) as const)
}

export const BoxOffice = define({
  name: "BoxOffice",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  controlStates: ["dark", "selling", "full", "curtain"],
  initial,
  acceptors: [
    acceptDoorsOpened,
    acceptSeatHeld,
    acceptSeatSold,
    acceptPaymentDeclined,
    acceptTick,
    acceptCurtainUp
  ],
  reactors: [releaseExpiredHolds],
  state,
  nap,
  actions: {
    OpenDoors: () => Clock.currentTimeMillis.pipe(Effect.map((at) => ({ _tag: "DoorsOpened", at }) as const)),
    Hold: ({ seat }) =>
      Effect.gen(function*() {
        const { patron } = yield* CurrentPatron
        const at = yield* Clock.currentTimeMillis
        return { _tag: "SeatHeld", seat, by: patron, at } as const
      }),
    Pay: ({ seat }) =>
      Effect.gen(function*() {
        const { patron } = yield* CurrentPatron
        const charge = yield* PaymentGateway.use((gateway) => gateway.charge(seat, patron))
        if (charge._tag === "Declined") return { _tag: "PaymentDeclined", seat, reason: charge.reason } as const
        return { _tag: "SeatSold", seat, by: patron } as const
      }),
    AwaitExpiry: ({ until }) =>
      Effect.gen(function*() {
        const before = yield* Clock.currentTimeMillis
        yield* Effect.sleep(Math.max(0, until - before))
        const now = yield* Clock.currentTimeMillis
        return { _tag: "Tick", now } as const
      }),
    RaiseCurtain: () => Clock.currentTimeMillis.pipe(Effect.map((at) => ({ _tag: "CurtainUp", at }) as const))
  }
})

export const BoxOfficePorts = makePorts(BoxOffice)

/** The same box office under another name, for an act that runs an instance of its own. */
export const company = (name: string): typeof BoxOffice => ({ ...BoxOffice, name })

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
  const tickTo = (until: number) => ({ _tag: "Tick", now: until }) as const
  return Option.toArray(Option.map(earliestHold(representation), tickTo))
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
    { _tag: "CurtainUp", at: model.now }
  ]
}

/** Seats taken and seats free matter to what a state enables; the clock and who holds what do not. */
export const serializeBoxOffice = (representation: Representation) =>
  `${representation.controlState}:${representation.free}:${representation.held > 0}:${representation.sold > 0}`
