import { BrowserRuntime } from "@effect/platform-browser"
import { type IntentOf, layerLoopLocal, type RepresentationOf } from "@mufw/core"
import { layerMount, type View } from "@mufw/view-uhtml"
import { Effect, Layer } from "effect"
import { html } from "uhtml"
import { List, ListPorts } from "../list.ts"

type Definition = typeof List
type Representation = RepresentationOf<Definition>
type Intent = IntentOf<Definition>

const rowView = (row: Representation["rows"][number], dispatch: (intent: Intent) => void) =>
  html`<li data-id=${row.id}><button onclick=${() => dispatch({ _tag: "Toggle", id: row.id })}>${row.on ? "on" : "off"}</button></li>`

/** The same markup, and the same unkeyed `.map`, as `list-uhtml`; the click becomes an intent instead of a call. */
const view: View<Representation, Intent> = (representation, dispatch) =>
  html`<output id="on">${representation.on}</output><ul id="rows">${representation.rows.map((row) => rowView(row, dispatch))}</ul>`

const page = layerMount(ListPorts, {
  root: document.getElementById("app")!,
  view,
  onRefused: () => Effect.void
}).pipe(Layer.provide(layerLoopLocal(List, ListPorts)))

BrowserRuntime.runMain(Layer.launch(page))
