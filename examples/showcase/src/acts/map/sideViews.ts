import { type Hole, html } from "uhtml"
import type { Chart } from "./Chart.ts"
import { tokensOf } from "./Printer.ts"
import { type Crossing, groupKey, type Intent, type Representation, type Run, runsOf, type Way } from "./Survey.ts"

type Dispatch = (intent: Intent) => void

type WayStatus = "pending" | "walking" | "done"

const classes = (...parts: ReadonlyArray<string | false>): string => parts.filter((part) => part !== false).join(" ")

/** The marquee numbers and the one-line answer to "is anything unreachable?". */
export const headView = (chart: Chart): Hole => {
  const answer = chart.unreachable.length === 0
    ? "no place on stage is unreachable"
    : `unreachable: ${chart.unreachable.join(", ")}`
  return html`<header class="map__head">
    <p class="map__kicker marquee">The blocking diagram</p>
    <p class="map__figures" data-spot="count">
      <span class="map__figure"><b class="marquee">${chart.states}</b> states,</span>
      <span class="map__figure"><b class="marquee">${chart.places}</b> places to stand</span>
    </p>
    <p class="map__unreachable" data-spot="unreachable">
      <span class=${classes("map__answer", chart.unreachable.length > 0 && "is-alarm")}>${answer}</span>
      <span class="mono map__call">unreachableControlStates(BoxOffice, graph)</span>
    </p>
  </header>`
}

const wayStatus = (representation: Representation, index: number): WayStatus => {
  if (representation.controlState === "done") return "done"
  if (representation.controlState === "resting") return "pending"
  if (index < representation.way) return "done"
  return index === representation.way ? "walking" : "pending"
}

const crossedIn = (run: Run, status: WayStatus, representation: Representation): number => {
  if (status === "done") return run.times
  if (status === "pending") return 0
  return Math.min(Math.max(representation.leg - run.first, 0), run.times)
}

const runView = (run: Run, status: WayStatus, representation: Representation): Hole => {
  const crossed = crossedIn(run, status, representation)
  const isCrossing = status === "walking" && crossed < run.times && representation.leg >= run.first
  const times = run.times > 1 ? html`<span class="walk__times mono">${`${crossed}/${run.times}`}</span>` : null
  return html`<li class=${classes("walk__run", isCrossing && "is-crossing", crossed === run.times && "is-crossed")}>
    <span class="walk__direction">[${run.leg.from} → ${run.leg.to} via <span class="mono walk__tag">${run.leg.tag}</span>]</span>
    ${times}
  </li>`
}

const wayView = (way: Way, index: number, representation: Representation): Hole => {
  const status = wayStatus(representation, index)
  const runs = runsOf(way.legs)
  const directions = runs.length === 0
    ? [html`<li class="walk__run is-crossed"><span class="walk__direction">[already standing at ${way.target}]</span></li>`]
    : runs.map((run) => runView(run, status, representation))
  return html`<li class=${classes("walk__way", `is-${status}`)}>
    <span class="walk__target marquee">to ${way.target}</span>
    <ul class="walk__runs">${directions}</ul>
  </li>`
}

const statusLine = (representation: Representation): string => {
  const routes = representation.ways.length
  if (representation.controlState === "walking") return `route ${representation.way + 1} of ${routes}`
  if (representation.controlState === "done") return `[${routes} routes walked, one to every place]`
  return "[the light waits in the wings]"
}

/** Every shortest path, written as stage directions, with the light's progress through them. */
export const walkView = (representation: Representation, dispatch: Dispatch): Hole =>
  html`<section class="map__walk" data-spot="walk" aria-labelledby="map-walk">
    <header class="map__section-head">
      <h2 class="marquee" id="map-walk">Walk every path</h2>
      <button
        type="button"
        class="stage-button"
        ?disabled=${representation.controlState === "walking"}
        onclick=${() => dispatch({ _tag: "Begin" })}
      >Walk again</button>
    </header>
    <ol class="walk__ways">${representation.ways.map((way, index) => wayView(way, index, representation))}</ol>
    <p class="walk__status mono" aria-live="polite">${statusLine(representation)}</p>
  </section>`

const crossingRow = (crossing: Crossing, latest: string): Hole => {
  const note = crossing.missed
    ? html`<span class="mine__note">the exploration never tried this crossing</span>`
    : null
  return html`<li class=${classes("mine__row", crossing.missed ? "is-missed" : "is-walked", groupKey(crossing) === latest && "is-latest")}>
    <span class="mine__where mono">${crossing.from} → ${crossing.to}</span>
    <span class="mine__tag mono">${crossing.tag}</span>
    <span class="mine__count marquee">×${crossing.count}</span>
    ${note}
  </li>`
}

/** What the visitor's own history crossed on the map, from `mergeHistory`. */
export const mineView = (representation: Representation): Hole => {
  const rows = representation.crossings.length === 0
    ? html`<p class="mine__empty">[Nobody has crossed the stage yet. Open the doors, hold a seat: Act I.]</p>`
    : html`<ul class="mine__rows">${representation.crossings.map((crossing) => crossingRow(crossing, representation.latest))}</ul>`
  return html`<section class="map__mine" data-spot="mine" aria-labelledby="map-mine">
    <h2 class="marquee" id="map-mine">The paths you walked tonight</h2>
    ${rows}
  </section>`
}

const codeLine = (line: string): Hole =>
  html`<span class="code__line">${tokensOf(line).map((token) => html`<span class=${`code__${token.kind}`}>${token.text}</span>`)}</span>`

/** The graph as an XState machine config, pretty-printed with its keys lit. */
export const cardView = (chart: Chart): Hole =>
  html`<aside class="map__card paper-card paper-card--torn" data-spot="xstate" style="--tilt: 0.7deg" aria-labelledby="map-xstate">
    <header class="card__head">
      <h2 class="marquee" id="map-xstate">The same map, as Stately reads it</h2>
      <p class="mono">toXStateDefinition(BoxOffice, graph)</p>
    </header>
    <div class="code mono" role="img" aria-label="The XState machine config of the Box Office">${chart.xstate.map(codeLine)}</div>
  </aside>`
