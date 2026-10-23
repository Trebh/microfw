import { BrowserRuntime } from "@effect/platform-browser"
import { layerHistoryList } from "@mufw/devtools"
import { layerInputScheduler } from "@mufw/view-uhtml"
import { Layer } from "effect"
import { Auction } from "../domain/Auction.ts"
import { Ports } from "../ports.ts"
import { layerConnectionBanner } from "./connectionBanner.ts"
import { historyOnly } from "./placements/historyOnly.ts"

const root = (id: string) => document.getElementById(id)!

/**
 * The server's history in a page of its own: no view, no wallet, no local model. The panel has no
 * travel, since the server this page targets serves `History` and not `TravelTo`.
 */
const page = Layer.merge(
  layerHistoryList(Auction, Ports, { root: root("devtools") }),
  layerConnectionBanner(root("connection"))
).pipe(Layer.provide(historyOnly), Layer.provide(layerInputScheduler))

BrowserRuntime.runMain(Layer.launch(page))
