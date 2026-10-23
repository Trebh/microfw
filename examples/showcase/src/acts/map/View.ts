import type { View } from "@mufw/view-uhtml"
import { html } from "uhtml"
import type { Chart } from "./Chart.ts"
import { floorView } from "./floorView.ts"
import { cardView, headView, mineView, walkView } from "./sideViews.ts"
import type { Intent, Representation } from "./Survey.ts"

/** The act's one island: the head, the floor, the routes, the visitor's crossings and the card, all from one representation. */
export const makeMapView = (chart: Chart): View<Representation, Intent> => (representation, dispatch) =>
  html`<div class="map">
    ${headView(chart)}
    <section class="map__floor" data-spot="floor" aria-label="The stage floor">${floorView(chart, representation)}</section>
    ${walkView(representation, dispatch)}
    ${mineView(representation)}
    ${cardView(chart)}
  </div>`
