import { Option } from "effect"
import { html } from "uhtml"
import { type Representation, SAMPLES_KEPT } from "./Meter.ts"

const SHORTEST_MILLIS = 0.1
const LOG_DECADES = 4

/** A time from click to result as a bar's height, 0 to 1, on a log scale from a tenth of a millisecond to a second, the same for every stage. */
export const heightOf = (millis: number): number => {
  const decades = Math.log10(Math.max(millis, SHORTEST_MILLIS)) - Math.log10(SHORTEST_MILLIS)
  return Math.min(1, decades / LOG_DECADES)
}

/** One decimal while the figure is small enough for it to matter, whole milliseconds after. */
export const formatMillis = (millis: number): string => (millis < 10 ? millis.toFixed(1) : String(Math.round(millis)))

const noteOf = (representation: Representation): string => {
  if (representation.controlState === "timing") return "timing…"
  return Option.match(representation.mean, {
    onNone: () => "click a seat to time it",
    onSome: (mean) => {
      const clicks = Math.min(representation.count, SAMPLES_KEPT)
      return clicks === 1 ? "your first click" : `average ${formatMillis(mean)} ms over your last ${clicks} clicks`
    }
  })
}

const bar = (millis: number) => html`<li class="tour__meter-bar" style=${`--h:${heightOf(millis)}`}></li>`

/** A stage's stopwatch: the last time from click to result, and the earlier ones as bars, oldest on the left. */
export const meterView = (representation: Representation) => {
  const figure = Option.match(representation.last, { onNone: () => "—", onSome: formatMillis })
  return html`<div class="tour__meter" data-state=${representation.controlState}>
    <p class="tour__meter-reading">
      <span class="tour__meter-figure marquee">${figure}</span>
      <span class="tour__meter-unit mono">ms</span>
    </p>
    <ol class="tour__meter-bars" aria-hidden="true">${representation.samples.map(bar)}</ol>
    <p class="tour__meter-note mono">${noteOf(representation)}</p>
  </div>`
}
