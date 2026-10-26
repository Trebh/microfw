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

/** One thing µFW costs: its figure, the plain page's figure beside it when one was measured, and what both mean. */
interface BillLine {
  readonly item: string
  readonly figure: string
  readonly plain?: string
  readonly note: string
}

/** Lines of the bill that one cue talks about together, under one spot. */
interface BillGroup {
  readonly spot: string
  readonly lines: ReadonlyArray<BillLine>
}

/**
 * `docs/architecture/performance.md` in everyday words. Every figure is quoted as that page prints it.
 * The pages are the project's bench pages, a counter and a 1000-row list, except the last group, which
 * is js-framework-benchmark's 1000-row table; the browser rows run at 4× CPU throttling, which that
 * page uses to stand for a mid-range phone.
 */
const bill: ReadonlyArray<BillGroup> = [
  {
    spot: "bill-weight",
    lines: [
      {
        item: "Download size",
        figure: "42.8 KiB",
        plain: "3.3 KiB",
        note:
          "The counter page, compressed: about 13 times bigger. Most of the difference is Effect, the library µFW is built on. You download it once."
      },
      {
        item: "First content",
        figure: "38.6 ms",
        plain: "16.7 ms",
        note:
          "Time until the counter appears, with the processor slowed to mid-range phone speed. The 1000-row list: 48.1 against 24.0 ms. Running the code: 25.9 against 3.5 ms."
      }
    ]
  },
  {
    spot: "bill-speed",
    lines: [
      {
        item: "Click to screen",
        figure: "15.2 ms",
        plain: "15.3 ms",
        note: "From a click to the next screen update. µFW draws the result inside the click itself, so you can't feel a difference."
      },
      {
        item: "Each step",
        figure: "2.875 µs",
        plain: "0.007 µs",
        note:
          "What one update of the counter's model costs in Node (a µs is a millionth of a second). The extra is a few µs whatever the update does, so it only stands out when the update does almost nothing."
      }
    ]
  },
  {
    spot: "bill-server",
    lines: [
      {
        item: "Server speed",
        figure: "7701 a second",
        note:
          "The most updates one definition applied in a second, with 10 connections (1 connection: 5926). It applies them one at a time, in order, so more users wait in line and don't get faster service."
      },
      {
        item: "1000 viewers",
        figure: "138.66 ms",
        note:
          "Time for one update to reach 1000 people watching (1.36 ms for one). Every update sends the whole view to each of them, not only the change."
      }
    ]
  },
  {
    spot: "bill-field",
    lines: [
      {
        item: "Against other frameworks",
        figure: "1.43×",
        plain: "1.36×",
        note:
          "Time on js-framework-benchmark's 1000-row table, the field's common test, relative to hand-written JavaScript (1.00×). The later passes: 1.32 against 1.27. Most of the gap is the renderer, not µFW."
      },
      {
        item: "Memory left over",
        figure: "2.106 MiB",
        plain: "0.770 MiB",
        note:
          "Memory left after creating and clearing 1000 rows five times; hand-written JavaScript: 0.643 MiB. Part of the extra is the history µFW keeps so steps can be replayed."
      }
    ]
  }
]

/** The cast's names fade with age: the first players to appear are the furthest in the past. */
const creditedCut = ["past-faded", "past-faded", "past-35", "past-35", "past-35", "past-10", "past-10", ""]

const billFigure = (line: BillLine) =>
  line.plain === undefined
    ? html`<span class="finale__figure marquee">${line.figure}</span>`
    : html`<span class="finale__figure marquee">${line.figure}<span class="finale__versus mono">vs ${line.plain}</span></span>`

const billLine = (line: BillLine) =>
  html`<div class="finale__line">
    <span class="finale__item">${line.item}</span>
    ${billFigure(line)}
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
        <p class="finale__baseline">
          Measured against the same pages written with uhtml alone, no framework: the project's bench pages, a
          counter and a list of 1000 rows, and js-framework-benchmark's 1000-row table. Read each figure as µFW
          vs plain uhtml.
        </p>
      </header>
      <ul class="finale__groups">${bill.map(billGroup)}</ul>
      <footer class="finale__total" data-spot="bill-total">
        <span class="marquee">In return</span>
        <span class="finale__total-text">checked, recorded steps that run in the browser, a worker or a server</span>
        <p class="finale__source">
          From the project's benchmark scripts and js-framework-benchmark, run on one laptop, so yours will
          differ. The performance notes in the docs explain how each figure was measured.
        </p>
      </footer>
    </section>

    <section class="finale__tally" data-spot="tally" aria-labelledby="finale-tally">
      <h2 class="finale__tally-head marquee" id="finale-tally">Recorded tonight</h2>
      <dl class="finale__counters">
        ${counter("deck steps", recorded.deck, "Every cue and every click on the controls.")}
        ${counter("box office steps", recorded.stage, "Every seat held, paid for or released.")}
        ${counter("rewinds", recorded.rewinds, "Times either one went back to an earlier step.")}
      </dl>
    </section>

    <section class="finale__reveal" data-spot="reveal">
      <p class="finale__reveal-text">Everything you did tonight was recorded.</p>
      <p class="finale__reveal-key">Press <kbd>B</kbd> to open the prompter's book and see the whole show.</p>
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
