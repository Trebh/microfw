import type { IntentOf, RepresentationOf } from "@mufw/core"
import type { View } from "@mufw/view-uhtml"
import { Option } from "effect"
import { html } from "uhtml"
import type {
  Intent as BoxIntent,
  Representation as BoxRepresentation,
  SeatView
} from "../../domain/BoxOffice.ts"
import { LIGHTS } from "./House.ts"
import type { Representation as MarqueeRepresentation, Sign } from "./Marquee.ts"
import type { Playhouse } from "./playhouse.ts"

type Send = (intent: BoxIntent) => void

/** Where each island and each history list mounts: the shell places them, the layers render into them. */
export interface Slots {
  readonly play: HTMLElement
  readonly playHistory: HTMLElement
  readonly front: HTMLElement
  readonly frontHistory: HTMLElement
  readonly sign: HTMLElement
  readonly signHistory: HTMLElement
}

const slot = (className: string, spot?: string): HTMLElement => {
  const element = document.createElement("div")
  element.className = className
  if (spot !== undefined) element.dataset.spot = spot
  return element
}

export const makeSlots = (): Slots => ({
  play: slot("within__slot"),
  playHistory: slot("hist hist--stacked", "history-nest"),
  front: slot("within__slot"),
  frontHistory: slot("hist"),
  sign: slot("within__slot"),
  signHistory: slot("hist")
})

const intentFor = (seat: SeatView): Option.Option<BoxIntent> => {
  if (seat.status === "free") return Option.some({ _tag: "Hold", seat: seat.id })
  if (seat.status === "held") return Option.some({ _tag: "Pay", seat: seat.id })
  return Option.none()
}

const pressSeat = (seat: SeatView, send: Send) => () =>
  Option.match(intentFor(seat), { onNone: () => undefined, onSome: send })

const seatButton = (send: Send) => (seat: SeatView) =>
  html`<button type="button" class="within__seat" data-status=${seat.status} ?disabled=${seat.status === "sold"}
    aria-label=${`${seat.id}, ${seat.status}`} onclick=${pressSeat(seat, send)}><span class="mono">${seat.id}</span></button>`

const seatMap = (seats: ReadonlyArray<SeatView>, send: Send, size: "play" | "front") =>
  html`<div class="within__seats" data-size=${size} role="group" aria-label="Seats">${seats.map(seatButton(send))}</div>`

const tallyLine = (representation: BoxRepresentation) =>
  Option.match(representation.lastRefusal, {
    onNone: () =>
      html`<p class="within__tally mono">${representation.free} free · ${representation.held} held · ${representation.sold} sold</p>`,
    onSome: (reason) => html`<p class="within__tally within__tally--refused mono" role="status">${reason}</p>`
  })

const isSelling = (representation: BoxRepresentation): boolean =>
  representation.controlState === "selling" || representation.controlState === "full"

const ticket = (label: string, enabled: boolean, onPress: () => void) =>
  html`<button type="button" class="stage-button within__ticket" ?disabled=${!enabled} onclick=${onPress}>${label}</button>`

const seatsWith = (representation: BoxRepresentation, status: SeatView["status"]): ReadonlyArray<SeatView> =>
  representation.seats.filter((seat) => seat.status === status)

/** The inner stage: curtain, seats and tally of the play, under the lamps of the house that owns it. */
export const playView: View<RepresentationOf<typeof Playhouse>, IntentOf<typeof Playhouse>> = (representation, dispatch) => {
  const { parent: house, child: play } = representation
  const send: Send = (intent) => dispatch({ _tag: "Child", intent })
  return html`<div class="within__play">
    <div class="within__proscenium" data-spot="proscenium">
      <ul class="within__lamps" aria-label="House lights">
        <li class="within__lamps-label marquee">House</li>
        ${LIGHTS.map((level) => html`<li class="within__lamp" data-lit=${String(level === house.controlState)}>${level}</li>`)}
      </ul>
      <div class="within__stage" data-open=${String(play.controlState === "curtain")}>
        <p class="within__title marquee">The Mousetrap</p>
        <i class="within__half within__half--l"></i>
        <i class="within__half within__half--r"></i>
      </div>
      ${seatMap(play.seats, send, "play")}
      ${tallyLine(play)}
    </div>
    <div class="within__model mono" data-spot="model">
      <p>{ parent: <b>${house.controlState}</b>, child: <b>${play.controlState}</b> }</p>
      <p>label <b>${representation.controlState}</b></p>
    </div>
    <div class="within__controls" data-spot="controls">
      ${ticket("Open doors", play.controlState === "dark", () => send({ _tag: "OpenDoors" }))}
      ${ticket("Raise curtain", isSelling(play), () => send({ _tag: "RaiseCurtain" }))}
      ${ticket("Dim the house", house.controlState !== "dark", () => dispatch({ _tag: "DimLights" }))}
      ${ticket("Raise the lights", house.controlState !== "up", () => dispatch({ _tag: "RaiseLights" }))}
    </div>
  </div>`
}

/** The box office out front: the same definition as the play's, on a loop of its own. */
export const frontView: View<BoxRepresentation, BoxIntent> = (representation, send) => {
  const holdEverySeat = () => seatsWith(representation, "free").forEach((seat) => send({ _tag: "Hold", seat: seat.id }))
  const payEveryHold = () => seatsWith(representation, "held").forEach((seat) => send({ _tag: "Pay", seat: seat.id }))
  return html`<div class="within__island">
    <header class="within__island-head">
      <h3 class="within__island-name mono">FrontOfHouse</h3>
      <span class="within__chip mono">${representation.controlState}</span>
    </header>
    ${seatMap(representation.seats, send, "front")}
    ${tallyLine(representation)}
    <div class="within__controls">
      ${ticket("Open doors", representation.controlState === "dark", () => send({ _tag: "OpenDoors" }))}
      ${ticket("Raise curtain", isSelling(representation), () => send({ _tag: "RaiseCurtain" }))}
      ${ticket("Hold every seat", isSelling(representation) && representation.free > 0, holdEverySeat)}
      ${ticket("Pay every hold", isSelling(representation) && representation.held > 0, payEveryHold)}
    </div>
  </div>`
}

const SIGN_TEXT: Record<Sign, string> = {
  tonight: "Seats tonight",
  few: "Few left",
  sold: "Sold out",
  playing: "Now playing"
}

const signNote = (representation: MarqueeRepresentation): string =>
  representation.controlState === "playing" ? "the curtain is up" : `${representation.free} seats free`

/** The lit sign. It has no buttons: it shows what it was last told, flickering in on each repaint. */
export const signView = (representation: MarqueeRepresentation) =>
  html`<div class="within__island">
    <header class="within__island-head">
      <h3 class="within__island-name mono">Marquee</h3>
      <span class="within__chip mono">${representation.repaints} repaints</span>
    </header>
    <div class="within__sign" role="status" data-sign=${representation.controlState} data-flip=${String(representation.repaints % 2)}>
      <span class="within__bulbs within__bulbs--top" aria-hidden="true"></span>
      <p class="within__sign-text marquee">${SIGN_TEXT[representation.controlState]}</p>
      <p class="within__sign-note mono">${signNote(representation)}</p>
      <span class="within__bulbs within__bulbs--bottom" aria-hidden="true"></span>
    </div>
  </div>`

/** The `forward` of `layerForward(frontPorts, marqueePorts, forward)`, as written in `forward.ts`. */
const forwardSource = [
  "export const repaintOnChange: Forward<Front, Painter> = (previous, current) =>",
  "  Option.exists(previous, (before) => looksTheSame(before, current))",
  "    ? Option.none()",
  "    : Option.some({ _tag: \"Repaint\", sign: signOf(current), free: current.free })"
]

const TOKEN = /("[^"]*"|\b(?:const|export)\b|\bOption\.\w+|\b(?:previous|current|before)\b)/

const tokenClass = (token: string): string => {
  if (token.startsWith("\"")) return "within__tok--string"
  if (token.startsWith("Option.")) return "within__tok--call"
  if (token === "const" || token === "export") return "within__tok--keyword"
  return "within__tok--arg"
}

/** `split` with a capture group puts every match at an odd index. */
const tokens = (line: string) =>
  line.split(TOKEN).map((piece, index) =>
    index % 2 === 1 ? html`<span class=${tokenClass(piece)}>${piece}</span>` : html`<span>${piece}</span>`
  )

const codeLine = (line: string) => html`<span class="within__code-line">${tokens(line)}</span>`

const compare = () =>
  html`<aside class="within__compare paper-card" data-spot="compare" aria-label="When to nest, when to forward">
    <section>
      <h3 class="within__verdict"><code class="mono">nest</code> <span class="marquee">when the parts must change together</span></h3>
      <ul>
        <li>Both parts change in the same step, so you never see one half updated and the other not.</li>
        <li>There is one history, so going back in time rewinds both parts.</li>
      </ul>
    </section>
    <section>
      <h3 class="within__verdict"><code class="mono">layerForward</code> <span class="marquee">when one program watches another</span></h3>
      <ul>
        <li>The watcher can live somewhere else: another page, a worker or a server.</li>
        <li>Each keeps its own history and logs the request later, as a step of its own.</li>
      </ul>
    </section>
  </aside>`

/** The act, once: two columns, one per way of composing, and the card that tells them apart. Islands render into the slots. */
export const shell = (slots: Slots) =>
  html`<div class="within">
    <section class="within__column" aria-labelledby="within-nest">
      <header class="within__head">
        <h2 class="within__heading" id="within-nest"><code class="within__fn">nest</code></h2>
        <p class="within__tagline marquee">one program, two parts that change together</p>
      </header>
      <div class="within__body within__body--nest">${slots.play}${slots.playHistory}</div>
    </section>
    <section class="within__column" aria-labelledby="within-forward">
      <header class="within__head">
        <h2 class="within__heading" id="within-forward"><code class="within__fn">layerForward</code></h2>
        <p class="within__tagline marquee">two programs, one watching the other</p>
      </header>
      <div class="within__body within__body--forward">
        <div class="within__islands" data-spot="islands">${slots.front}${slots.sign}</div>
        <pre class="within__code mono" data-spot="forward-code"><code>${forwardSource.map(codeLine)}</code></pre>
        <div class="within__histories" data-spot="histories">${slots.frontHistory}${slots.signHistory}</div>
      </div>
    </section>
    ${compare()}
  </div>`
