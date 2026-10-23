import type { View } from "@mufw/view-uhtml"
import { Option } from "effect"
import { html } from "uhtml"
import { HOLD_MILLIS, type Intent, type Representation, type SeatView } from "../../domain/BoxOffice.ts"

type Dispatch = (intent: Intent) => void

const isOpen = (representation: Representation): boolean =>
  representation.controlState === "selling" || representation.controlState === "full"

/** A free seat is held, a held seat is paid for, a sold seat has nothing left to ask. */
const intentFor = (seat: SeatView): Option.Option<Intent> => {
  if (seat.status === "free") return Option.some({ _tag: "Hold", seat: seat.id })
  if (seat.status === "held") return Option.some({ _tag: "Pay", seat: seat.id })
  return Option.none()
}

const hintFor = (seat: SeatView): string => {
  if (seat.status === "free") return `${seat.id}: free, press to hold`
  if (seat.status === "held") return `${seat.id}: held, press to pay`
  return `${seat.id}: sold`
}

const seat = (representation: Representation, dispatch: Dispatch) => (view: SeatView) => {
  const intent = intentFor(view)
  const press = () => Option.match(intent, { onNone: () => undefined, onSome: dispatch })
  return html`<button
    type="button"
    class="tour__seat"
    data-status=${view.status}
    ?disabled=${!isOpen(representation) || Option.isNone(intent)}
    aria-label=${hintFor(view)}
    title=${hintFor(view)}
    style=${`--hold:${HOLD_MILLIS}ms`}
    onclick=${press}
  >
    <span class="tour__seat-id mono">${view.id}</span>
    <span class="tour__seat-fuse"></span>
  </button>`
}

const doorsLabel = (representation: Representation): string => {
  if (representation.controlState === "dark") return "doors closed"
  if (representation.controlState === "curtain") return "curtain up"
  return representation.controlState === "full" ? "house full" : "doors open"
}

/**
 * The seat map every stage shows: the house, rows A to C, painted from a representation of the box
 * office and nothing else. It cannot tell a loop in this page from one in a worker or across a wire.
 */
export const seatMap: View<Representation, Intent> = (representation, dispatch) => {
  const refusal = Option.getOrElse(representation.lastRefusal, () => "")
  return html`<div class="tour__seatmap" data-state=${representation.controlState}>
    <div class="tour__seat-rows">${representation.seats.map(seat(representation, dispatch))}</div>
    <p class="tour__tally mono">
      <span class="tour__doors">${doorsLabel(representation)}</span>
      <span>${representation.free} free</span>
      <span>${representation.held} held</span>
      <span>${representation.sold} sold</span>
    </p>
    <p class="tour__note" data-empty=${refusal === "" ? "yes" : "no"}>${refusal}</p>
  </div>`
}
