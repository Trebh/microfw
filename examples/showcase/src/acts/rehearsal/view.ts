import { html } from "uhtml"
import type { Representation as BoxOfficeRepresentation, SeatView } from "../../domain/BoxOffice.ts"
import { graphEdges, type GraphEdgeNote, type GraphNodeNote, graphNodes } from "./sheet.ts"

const graphNode = (node: GraphNodeNote) =>
  html`<li class="rehearsal__node" data-node=${node.name}>
    <span class="rehearsal__node-name marquee">${node.name}</span>
    <span class="rehearsal__node-expects">${node.expects}</span>
  </li>`

const graphEdge = (edge: GraphEdgeNote) =>
  html`<li class="rehearsal__edge mono">
    <span class="rehearsal__edge-end">${edge.from}</span>
    <span class="rehearsal__edge-proposal">${edge.proposal}${edge.times > 1 ? ` ×${edge.times}` : ""}</span>
    <span class="rehearsal__edge-end">${edge.to}</span>
  </li>`

/**
 * The static island: the graph the paths come from, and the places the live parts are mounted into
 * (`.rehearsal__sheet`, and one `.rehearsal__house` per understudy).
 */
export const shell = () =>
  html`<div class="rehearsal">
    <header class="rehearsal__head">
      <p class="rehearsal__kicker marquee">Act IV</p>
      <h1 class="rehearsal__title">Rehearsal</h1>
      <p class="rehearsal__feature mono">@mufw/test · model-based testing</p>
    </header>

    <section class="rehearsal__graph" data-spot="graph" aria-labelledby="rehearsal-graph">
      <h2 class="rehearsal__heading marquee" id="rehearsal-graph">The graph <span class="past-35">every state the test library found</span></h2>
      <ul class="rehearsal__nodes">${graphNodes.map(graphNode)}</ul>
      <ul class="rehearsal__edges">${graphEdges.map(graphEdge)}</ul>
    </section>

    <section class="rehearsal__sheet" data-spot="sheet" aria-labelledby="rehearsal-sheet"></section>

    <section class="rehearsal__bench" data-spot="bench" aria-labelledby="rehearsal-bench">
      <h2 class="rehearsal__heading marquee" id="rehearsal-bench">The understudy <span class="past-35">a second Box Office for the test</span></h2>
      <div class="rehearsal__panes">
        <figure class="rehearsal__pane" data-understudy="honest">
          <div class="rehearsal__house" data-house="honest"></div>
          <figcaption class="mono">Understudy</figcaption>
        </figure>
        <figure class="rehearsal__pane" data-understudy="sabotaged">
          <div class="rehearsal__house" data-house="sabotaged"></div>
          <figcaption class="mono">Sabotaged understudy</figcaption>
        </figure>
      </div>
    </section>
  </div>`

const seat = (place: SeatView) =>
  html`<li class="rehearsal__seat" data-status=${place.status}><span class="mono">${place.id}</span></li>`

/** The miniature seat map of one understudy: every step of a path shows here as it happens. */
export const houseView = (representation: BoxOfficeRepresentation) =>
  html`<ol class="rehearsal__seats">${representation.seats.map(seat)}</ol>
    <p
      class="rehearsal__reading mono"
      data-control=${representation.controlState}
      data-free=${String(representation.free)}
    >reads <b>${representation.controlState}</b> · ${representation.free} free</p>`
