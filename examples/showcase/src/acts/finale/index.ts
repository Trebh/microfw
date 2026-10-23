import type { HistoryPort } from "@mufw/core"
import { Effect, Layer, Stream } from "effect"
import { html, render } from "uhtml"
import type { Act } from "../../act.ts"
import { cast, type CastMember } from "../../deck/cast.ts"
import { Deck, DeckPorts } from "../../deck/Deck.ts"
import { BoxOffice, BoxOfficePorts } from "../../domain/BoxOffice.ts"
import "./style.css"
import { script } from "./script.ts"
import { emptyTally, type Seen, type Source, tally, type Tally } from "./tally.ts"

interface BillLine {
  readonly item: string
  readonly figure: string
  readonly note: string
}

/** Lines of the bill that one cue talks about together, under one spot. */
interface BillGroup {
  readonly spot: string
  readonly lines: ReadonlyArray<BillLine>
}

/** The README's "What it costs", line by line; the figures are quoted, not rounded off. */
const bill: ReadonlyArray<BillGroup> = [
  {
    spot: "bill-weight",
    lines: [
      {
        item: "Bundle",
        figure: "about 20×",
        note:
          "The smallest µFW page ships about twenty times the JavaScript of the plain page: tens of KiB gzipped, most of it the Effect runtime and Schema."
      },
      {
        item: "Startup",
        figure: "2–3×",
        note: "First content takes two to three times as long; script time three to seven times."
      }
    ]
  },
  {
    spot: "bill-speed",
    lines: [
      {
        item: "Interaction",
        figure: "same task",
        note:
          "layerInputScheduler runs the fiber hops of a click as microtasks in the task of the click, so its step is shown in the same task as in the plain page."
      },
      {
        item: "Steps",
        figure: "a few µs",
        note:
          "A step costs a few microseconds over the reducer it runs, an intent's round trip tens. Fixed costs: they fade as the domain does more work."
      }
    ]
  },
  {
    spot: "bill-server",
    lines: [
      {
        item: "Server",
        figure: "1 writer",
        note:
          "One definition is one serialised writer: proposals per second do not grow with connections. Every update sends the whole representation to every subscriber."
      }
    ]
  }
]

/** Redaction degrades with age: the first player to appear is the furthest in the past. */
const creditedCut = ["past-100", "past-100", "past-70", "past-70", "past-35", "past-35", "past-10", ""]

const billLine = (line: BillLine) =>
  html`<div class="finale__line">
    <span class="finale__item">${line.item}</span>
    <span class="finale__figure marquee">${line.figure}</span>
    <p class="finale__note">${line.note}</p>
  </div>`

const billGroup = (group: BillGroup) =>
  html`<li class="finale__group" data-spot=${group.spot}>${group.lines.map(billLine)}</li>`

const credit = (member: CastMember, index: number) =>
  html`<li class="finale__credit">
    <span class=${`finale__credit-name ${creditedCut[index] ?? ""}`}>${member.name}</span>
    <code class="finale__credit-code mono">${member.code}</code>
  </li>`

const counter = (label: string, count: number, note: string) =>
  html`<div class="finale__counter">
    <dt class="finale__count-label">${label}</dt>
    <dd class="finale__count marquee live">${count}</dd>
    <dd class="finale__count-note">${note}</dd>
  </div>`

const finale = (recorded: Tally) =>
  html`<div class="finale">
    <header class="finale__head">
      <p class="finale__kicker marquee">Curtain call</p>
      <h1 class="finale__title">Good night.</h1>
    </header>

    <section class="finale__bill paper-card paper-card--torn" data-spot="bill" aria-labelledby="finale-bill">
      <header class="finale__bill-head">
        <h2 class="marquee" id="finale-bill">The bill</h2>
        <p class="mono">what µFW costs · measured against plain uhtml</p>
      </header>
      <ul class="finale__groups">${bill.map(billGroup)}</ul>
      <footer class="finale__total" data-spot="bill-total">
        <span class="marquee">Total</span>
        <span class="finale__total-text">a typed, recorded, relocatable loop</span>
        <p class="finale__source mono">every figure, its baseline and its command: docs/architecture/performance.md</p>
      </footer>
    </section>

    <section class="finale__tally" data-spot="tally" aria-labelledby="finale-tally">
      <h2 class="finale__tally-head marquee" id="finale-tally">Recorded tonight</h2>
      <dl class="finale__counters">
        ${counter("deck", recorded.deck, "steps: every cue and every click on the controls")}
        ${counter("box office", recorded.stage, "steps: every seat held, paid for or released")}
        ${counter("rewinds", recorded.rewinds, "travels back in time, by either loop")}
      </dl>
    </section>

    <section class="finale__reveal" data-spot="reveal">
      <p class="finale__reveal-text">Everything you did tonight is on record.</p>
      <p class="finale__reveal-key">Press <kbd>B</kbd>: the whole show is in the prompter's book.</p>
    </section>

    <section class="finale__credits" data-spot="credits" aria-labelledby="finale-credits">
      <h2 class="finale__credits-head marquee" id="finale-credits">The company</h2>
      <ol>${cast.map(credit)}</ol>
    </section>
  </div>`

const seenFrom = (source: Source) => (record: { readonly kind: Seen["kind"] }): Seen => ({ source, kind: record.kind })

/**
 * Curtain call. The counters fold the records of the deck's and the box office's histories, so they
 * start from everything already recorded and follow every step after it.
 */
export const finaleAct: Act<HistoryPort<typeof Deck> | HistoryPort<typeof BoxOffice>> = {
  script,
  layer: (root) =>
    Layer.effectDiscard(
      Effect.gen(function*() {
        const deck = yield* DeckPorts.HistoryPort
        const stage = yield* BoxOfficePorts.HistoryPort
        const paint = (recorded: Tally) => Effect.sync(() => render(root, finale(recorded)))
        const seen = Stream.merge(
          deck.records.pipe(Stream.map(seenFrom("deck"))),
          stage.records.pipe(Stream.map(seenFrom("stage")))
        )
        yield* paint(emptyTally)
        yield* Effect.forkScoped(Stream.runForEach(seen.pipe(Stream.scan(() => emptyTally, tally)), paint))
      })
    )
}
