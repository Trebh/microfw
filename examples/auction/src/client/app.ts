import { BrowserRuntime } from "@effect/platform-browser"
import { exploreGraph, type HistoryPort, type IntentPort, type ModelPort, toXStateDefinition } from "@mufw/core"
import { layerPanel, layerStately } from "@mufw/devtools"
import { layerMount } from "@mufw/view-uhtml"
import { createBrowserInspector } from "@statelyai/inspect"
import { Layer } from "effect"
import { Auction, exploreAuction, serializeAuction } from "../domain/Auction.ts"
import { Ports } from "../ports.ts"
import { makeView } from "../view.ts"
import { parseBidder } from "./placement.ts"

type A = typeof Auction

/** What a page needs from a placement. */
export type PagePorts = Layer.Layer<IntentPort<A> | ModelPort<A> | HistoryPort<A>>

const root = (id: string) => document.getElementById(id)!

/**
 * Browsers block a popup not opened by a user gesture, so the inspector starts from a click and
 * buffers events until then (enough for a whole auction: two events per tick).
 */
const makeInspector = () => {
  const inspector = createBrowserInspector({ autoStart: false, maxDeferredEvents: 10_000 })
  const button = root("inspect")
  button.hidden = false
  button.onclick = () => inspector.start()
  return layerStately(Auction, Ports, inspector, {
    definition: toXStateDefinition(Auction, exploreGraph(Auction, exploreAuction, { serialize: serializeAuction }))
  })
}

/** Mounts the auction page over `placement` and runs it until the page is discarded. */
export const runPage = (placement: PagePorts, label: string) => {
  const search = location.search
  const inspector = new URLSearchParams(search).get("inspect") === "1" ? makeInspector() : Layer.empty
  const bidder = parseBidder(search)
  const page = Layer.mergeAll(
    layerMount(Ports, { root: root("app"), view: makeView(bidder, `${label} · bidder ${bidder}`) }),
    layerPanel(Ports, { root: root("devtools") }),
    inspector
  ).pipe(Layer.provide(placement))
  BrowserRuntime.runMain(Layer.launch(page))
}
