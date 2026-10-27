import type { IntentOf, RepresentationOf } from "@mufw/core"
import type { View } from "@mufw/view-uhtml"
import { Option } from "effect"
import { html } from "uhtml"
import type {
  Intent as BoxIntent,
  Representation as BoxRepresentation,
  SeatView
} from "../../domain/BoxOffice.ts"
import type { Repertory } from "./repertory.ts"
import type { Representation as SeasonRepresentation } from "./Season.ts"

type Dispatch = (intent: IntentOf<typeof Repertory>) => void
type Send = (intent: BoxIntent) => void
type Night = RepresentationOf<typeof Repertory>["parts"]["Nights"][number]

/** Where the island and the history list mount: the shell places them, the layers render into them. */
export interface Slots {
  readonly stage: HTMLElement
  readonly history: HTMLElement
}

const slot = (className: string, spot?: string): HTMLElement => {
  const element = document.createElement("div")
  element.className = className
  if (spot !== undefined) element.dataset.spot = spot
  return element
}

export const makeSlots = (): Slots => ({
  stage: slot("repertory__slot"),
  history: slot("hist hist--stacked", "history")
})

const intentFor = (seat: SeatView): Option.Option<BoxIntent> => {
  if (seat.status === "free") return Option.some({ _tag: "Hold", seat: seat.id })
  if (seat.status === "held") return Option.some({ _tag: "Pay", seat: seat.id })
  return Option.none()
}

const pressSeat = (seat: SeatView, send: Send) => () =>
  Option.match(intentFor(seat), { onNone: () => undefined, onSome: send })

const seatButton = (send: Send) => (seat: SeatView) =>
  html`<button type="button" class="repertory__seat" data-status=${seat.status} ?disabled=${seat.status === "sold"}
    aria-label=${`${seat.id}, ${seat.status}`} onclick=${pressSeat(seat, send)}><span class="mono">${seat.id}</span></button>`

const seatMap = (seats: ReadonlyArray<SeatView>, send: Send) =>
  html`<div class="repertory__seats" role="group" aria-label="Seats">${seats.map(seatButton(send))}</div>`

const tallyLine = (representation: BoxRepresentation) =>
  Option.match(representation.lastRefusal, {
    onNone: () =>
      html`<p class="repertory__tally mono">${representation.free} free · ${representation.held} held · ${representation.sold} sold</p>`,
    onSome: (reason) => html`<p class="repertory__tally repertory__tally--refused mono" role="status">${reason}</p>`
  })

const isSelling = (representation: BoxRepresentation): boolean =>
  representation.controlState === "selling" || representation.controlState === "full"

const ticket = (label: string, enabled: boolean, onPress: () => void, spot?: string) =>
  html`<button type="button" class="stage-button repertory__ticket" data-spot=${spot} ?disabled=${!enabled}
    onclick=${onPress}>${label}</button>`

const freeSeats = (representation: BoxRepresentation): ReadonlyArray<SeatView> =>
  representation.seats.filter((seat) => seat.status === "free")

/** One night on the bill: its own box office, addressed through the collection by its key. */
const nightCard = (dispatch: Dispatch) => ({ key, representation }: Night) => {
  const send: Send = (intent) => dispatch({ _tag: "Nights", key, intent })
  const holdEverySeat = () => freeSeats(representation).forEach((seat) => send({ _tag: "Hold", seat: seat.id }))
  const selling = isSelling(representation)
  return html`<article class="repertory__night" aria-label=${`Nights[${key}]`}>
    <header class="repertory__night-head">
      <h3 class="repertory__night-name mono">Nights[${key}]</h3>
      <span class="repertory__chip mono">${representation.controlState}</span>
    </header>
    ${seatMap(representation.seats, send)}
    ${tallyLine(representation)}
    <div class="repertory__controls">
      ${ticket("Open doors", representation.controlState === "dark", () => send({ _tag: "OpenDoors" }))}
      ${ticket("Hold every seat", selling && representation.free > 0, holdEverySeat)}
      ${ticket("Raise curtain", selling, () => send({ _tag: "RaiseCurtain" }), "played")}
      ${ticket("Cancel", true, () => dispatch({ _tag: "CancelNight", night: key }), "cancel")}
    </div>
  </article>`
}

/** Always a list: uhtml 4 fixes a hole as a list or a single node at its first render. */
const nightList = (nights: ReadonlyArray<Night>, dispatch: Dispatch) =>
  nights.length === 0
    ? [html`<p class="repertory__empty mono">parts.Nights = []</p>`]
    : nights.map(nightCard(dispatch))

const listed = (nights: ReadonlyArray<string>): string => `[${nights.join(", ")}]`

const playedLine = (season: SeasonRepresentation): string =>
  `played: ${season.played.length === 0 ? "none" : season.played.join(", ")}`

const programmeButton = (season: SeasonRepresentation, dispatch: Dispatch) =>
  Option.match(season.next, {
    onNone: () => ticket("Programme", false, () => undefined),
    onSome: (night) => ticket(`Programme ${night}`, true, () => dispatch({ _tag: "ProgrammeNight", night }))
  })

/** The season's bill, with the line that shows the collection following the parent's model. */
const bill = (representation: RepresentationOf<typeof Repertory>, dispatch: Dispatch) => {
  const season = representation.parent
  const keys = representation.parts.Nights.map((night) => night.key)
  return html`<aside class="repertory__bill paper-card" data-spot="bill">
    <header class="repertory__bill-head">
      <h2 class="repertory__bill-title marquee">In Repertory</h2>
      <span class="repertory__bill-state mono">${season.controlState}</span>
    </header>
    <ul class="repertory__programme">
      ${season.programme.map((night) => html`<li class="mono">Nights[${night}]</li>`)}
    </ul>
    <p class="repertory__played">${playedLine(season)}</p>
    <div class="repertory__model" data-spot="programme">
      <p class="mono">programme <b>${listed(season.programme)}</b> → parts.Nights <b>${listed(keys)}</b></p>
      <div class="repertory__bill-controls">
        ${programmeButton(season, dispatch)}
        ${ticket("Open the season", season.controlState === "planning", () => dispatch({ _tag: "OpenSeason" }), "open")}
      </div>
    </div>
  </aside>`
}

/** The season on the left, one card per night on its bill: one definition, one loop. */
export const stageView: View<RepresentationOf<typeof Repertory>, IntentOf<typeof Repertory>> = (representation, dispatch) =>
  html`<div class="repertory__stage">
    ${bill(representation, dispatch)}
    <div class="repertory__nights" data-spot="nights">${nightList(representation.parts.Nights, dispatch)}</div>
  </div>`

const compare = () =>
  html`<aside class="repertory__compare paper-card" data-spot="compare" aria-label="When to nest, compose or forward">
    <section>
      <h3 class="repertory__verdict"><code class="mono">nest</code> <span class="marquee">one part inside another</span></h3>
      <ul>
        <li>Two parts, fixed when the program is written, changing in the same step.</li>
        <li>Each side forwards to the other: toParent, toChild.</li>
      </ul>
    </section>
    <section>
      <h3 class="repertory__verdict"><code class="mono">compose</code> <span class="marquee">named parts, or as many as the parent lists</span></h3>
      <ul>
        <li>Slots by name, or a collection keyed by the parent's model; still one step, one history, one graph.</li>
        <li>A part talks only to the parent (toParent, fromParent). A night cannot drop itself or tell another night anything: that goes through a Season proposal.</li>
      </ul>
    </section>
    <section>
      <h3 class="repertory__verdict"><code class="mono">layerForward</code> <span class="marquee">separate programs</span></h3>
      <ul>
        <li>Each keeps its own loop and history, and can run elsewhere: a worker, a server.</li>
        <li>The watcher logs the request later, as a step of its own.</li>
      </ul>
    </section>
  </aside>`

/** The act, once: the stage, the loop's history beside it, and the card that tells the three ways apart. */
export const shell = (slots: Slots) => html`<div class="repertory">${slots.stage}${slots.history}${compare()}</div>`
