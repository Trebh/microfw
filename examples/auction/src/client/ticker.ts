import { BrowserRuntime } from "@effect/platform-browser"
import type { ModelPort } from "@mufw/core"
import { layerInputScheduler, layerMountReadOnly } from "@mufw/view-uhtml"
import { Layer, type Schema } from "effect"
import type { Auction } from "../auction/Auction.ts"
import { Ports } from "../ports.ts"
import { makeTickerView } from "../auction/Ticker.view.dom.ts"

/**
 * Where a ticker reads the server's auction from: a placement that provides the remote `ModelPort`
 * and nothing else, and the line its view shows as the source.
 */
export interface TickerTransport {
  readonly placement: Layer.Layer<ModelPort<typeof Auction>, Schema.SchemaError>
  readonly source: string
}

/**
 * Mounts the ticker island into `root` until the page is discarded: the auction's control state and
 * highest bid, read from the server's `Representations` through `transport`. It has its own placement,
 * apart from the page's, and no intent port, so it cannot act on the auction.
 */
export const runTicker = (root: Element, transport: TickerTransport) => {
  const view = makeTickerView(transport.source)
  const ticker = layerMountReadOnly(Ports, { root, view }).pipe(
    Layer.provide(transport.placement),
    Layer.provide(layerInputScheduler)
  )
  BrowserRuntime.runMain(Layer.launch(ticker))
}
