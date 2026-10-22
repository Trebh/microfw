import { BrowserRuntime } from "@effect/platform-browser"
import { exploreGraph, type HistoryPort, type IntentPort, type ModelPort, toXStateDefinition } from "@mufw/core"
import { layerPanel, layerStately, replayOnStart } from "@mufw/devtools"
import { layerMount } from "@mufw/view-uhtml"
import { createBrowserInspector } from "@statelyai/inspect"
import { Layer, type Schema } from "effect"
import { html, render } from "uhtml"
import { Auction, exploreAuction, serializeAuction } from "../domain/Auction.ts"
import { Ports } from "../ports.ts"
import { makeView } from "../view.ts"
import { layerConnectionBanner } from "./connectionBanner.ts"
import { layerRefusalNoticeWith } from "./refusalNotice.ts"
import { layerRefusals, Refusals } from "./refusals.ts"

type A = typeof Auction

/** What a page needs from a placement. A placement that reads its settings can fail with their decoding error. */
export type PagePorts = Layer.Layer<IntentPort<A> | ModelPort<A> | HistoryPort<A>, Schema.SchemaError>

/** Layers a page mounts beside its view, e.g. the time-travel panel. */
export type PageDevtools = Layer.Layer<never, never, HistoryPort<A>>

const root = (id: string) => document.getElementById(id)!

/** A strip above the view, created here so every page gets it without its own markup; later strips sit closer to the view. */
const stripAboveView = () => {
  const strip = document.createElement("div")
  root("app").before(strip)
  return strip
}

const layerRefusalNotice = layerRefusalNoticeWith(html, render)

/** The time-travel panel; its row clicks call `TravelTo`, so only pages whose server serves it may mount it. */
export const layerTimeTravel = (): PageDevtools => layerPanel(Ports, { root: root("devtools") })

/**
 * Browsers block a popup not opened by a user gesture, so the inspector starts from a click. It
 * buffers events until then, and `replayOnStart` re-sends the actor and latest snapshot that the
 * bounded buffer may have dropped.
 */
const makeInspector = () => {
  const inspector = replayOnStart(createBrowserInspector({ autoStart: false, maxDeferredEvents: 10_000 }))
  const button = root("inspect")
  button.hidden = false
  button.onclick = () => inspector.start()
  return layerStately(Auction, Ports, inspector, {
    definition: toXStateDefinition(Auction, exploreGraph(Auction, exploreAuction, { serialize: serializeAuction }))
  })
}

/** Mounts the auction page over `placement`, labelled `label` (placement and identity), with `devtools` beside the view, until the page is discarded. */
export const runPage = (placement: PagePorts, label: string, devtools: PageDevtools) => {
  const search = location.search
  const inspector = new URLSearchParams(search).get("inspect") === "1" ? makeInspector() : Layer.empty
  const page = Layer.mergeAll(
    layerMount(Ports, {
      root: root("app"),
      view: makeView(label),
      onRefused: (refused) => Refusals.use((refusals) => refusals.report(refused))
    }),
    layerConnectionBanner(stripAboveView()),
    layerRefusalNotice(stripAboveView()),
    devtools,
    inspector
  ).pipe(Layer.provide(placement), Layer.provide(layerRefusals))
  BrowserRuntime.runMain(Layer.launch(page))
}
