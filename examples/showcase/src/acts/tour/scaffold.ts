import { html } from "uhtml"
import { type CodeLine, ELISION, houseRoot, sharedImports, type Token, tokenize, townRoot, wingsRoot } from "./code.ts"
import type { Mounts } from "./island.ts"
import { NETWORK_MILLIS } from "./placements.ts"
import { house, type Stage, town, wings } from "./stages.ts"

/** What a stage card says about its stage; what runs in it is in `placements.ts`. */
export interface Card {
  readonly stage: Stage
  readonly ordinal: string
  readonly title: string
  readonly where: string
  readonly root: ReadonlyArray<CodeLine>
}

export const cards: ReadonlyArray<Card> = [
  {
    stage: house,
    ordinal: "1",
    title: "In the house",
    where: "runs in this page",
    root: houseRoot
  },
  {
    stage: wings,
    ordinal: "2",
    title: "In the wings",
    where: "runs in a web worker, a background thread (company.worker.ts)",
    root: wingsRoot
  },
  {
    stage: town,
    ordinal: "3",
    title: "Across town",
    where: `acts like a server, but runs in this page, with a ${NETWORK_MILLIS} ms wait added`,
    root: townRoot
  }
]

const token = (part: Token) => html`<span class=${`tour__tok tour__tok--${part.kind}`}>${part.text}</span>`

const kindOfLine = (line: CodeLine): string => {
  if (line.text === ELISION) return "elision"
  return line.marked ? "marked" : "plain"
}

const codeLine = (line: CodeLine) =>
  html`<span class="tour__line" data-kind=${kindOfLine(line)}>${tokenize(line.text).map(token)}</span>`

const stageCard = (card: Card, mounts: Mounts) =>
  html`<article class="tour__stage" data-spot=${card.stage.id} data-stage=${card.stage.id}>
    <header class="tour__stage-head">
      <span class="tour__ordinal marquee">${card.ordinal}</span>
      <h2 class="tour__title">${card.title}</h2>
      ${mounts.lamp}
    </header>
    <p class="tour__where mono">${card.where}</p>
    <figure class="tour__root">
      <figcaption class="tour__caption marquee">setup code · marked lines differ</figcaption>
      <pre class="tour__code mono"><code>${card.root.map(codeLine)}</code></pre>
    </figure>
    ${mounts.seats}
  </article>`

const boardCell = (card: Card, mounts: Mounts) =>
  html`<div class="tour__board-cell" data-stage=${card.stage.id}>
    <p class="tour__board-label marquee">${card.title}</p>
    ${mounts.meter}
  </div>`

const imports = () =>
  html`<figure class="tour__imports" data-spot="imports">
    <figcaption class="tour__caption marquee">every stage has these two imports</figcaption>
    <pre class="tour__code mono"><code>${sharedImports.map((line) => codeLine({ text: line, marked: false }))}</code></pre>
  </figure>`

/**
 * The act's markup, rendered once: the three stage cards and the board of stopwatches are built
 * around elements that the stages paint into on their own, so this template is never re-rendered.
 */
export const tour = (mounts: Readonly<Record<Stage["id"], Mounts>>) =>
  html`<div class="tour">
    <header class="tour__head">
      <div class="tour__banner" data-spot="banner">
        <p class="tour__kicker marquee">Act V · On tour</p>
        <h1 class="tour__statement">
          The program stays the same.
          <em class="tour__only">Only the setup changes.</em>
        </h1>
      </div>
      ${imports()}
    </header>
    <div class="tour__stages" data-spot="stages">${cards.map((card) => stageCard(card, mounts[card.stage.id]))}</div>
    <section class="tour__board" data-spot="meters" aria-label="Time from click to result">
      <div class="tour__board-cells">${cards.map((card) => boardCell(card, mounts[card.stage.id]))}</div>
      <p class="tour__board-caption mono">
        time from your click until the seat changes on screen · each bar is one click, newest on the right · log scale, 0.1 ms at the bottom to 1 s at the top
      </p>
    </section>
  </div>`
