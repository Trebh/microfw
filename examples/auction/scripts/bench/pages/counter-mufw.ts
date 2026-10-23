import { BrowserRuntime } from "@effect/platform-browser"
import { type IntentOf, layerLoopLocal, type RepresentationOf } from "@mufw/core"
import { layerMount, type View } from "@mufw/view-uhtml"
import { Effect, Layer } from "effect"
import { html } from "uhtml"
import { Counter, CounterPorts } from "../counter.ts"

type Definition = typeof Counter

/** The same markup as `counter-uhtml`; the click becomes an intent instead of a call. */
const view: View<RepresentationOf<Definition>, IntentOf<Definition>> = (representation, dispatch) =>
  html`<button id="inc" onclick=${() => dispatch({ _tag: "Inc", by: 1 })}>+1</button><output id="count">${representation.count}</output>`

const page = layerMount(CounterPorts, {
  root: document.getElementById("app")!,
  view,
  onRefused: () => Effect.void
}).pipe(Layer.provide(layerLoopLocal(Counter, CounterPorts)))

BrowserRuntime.runMain(Layer.launch(page))
