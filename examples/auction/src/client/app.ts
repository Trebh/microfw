import { BrowserRuntime } from "@effect/platform-browser"
import {
  exploreGraph,
  type HistoryPort,
  type IntentPort,
  type ModelPort,
  toXStateDefinition
} from "@mufw/core"
import { layerPanel, layerStately, replayOnStart } from "@mufw/devtools"
import { layerInputScheduler, layerMount } from "@mufw/view-uhtml"
import { createBrowserInspector } from "@statelyai/inspect"
import { Effect, Layer, Option, type Schema } from "effect"
import type { WorkerError } from "effect/workers/WorkerError"
import { html, render } from "uhtml"
import { exploreAuction, serializeAuction } from "../auction/Auction.explore.ts"
import { Auction } from "../auction/Auction.ts"
import { makeAuctionView } from "../auction/Auction.view.dom.ts"
import type { Whoami } from "../domain/Whoami.ts"
import { Ports, WalletPorts } from "../ports.ts"
import { makeWalletView } from "../wallet/Wallet.view.dom.ts"
import { layerConnectionBanner } from "./connectionBanner.ts"
import { layerHeldNoticeWith } from "./heldNotice.ts"
import { walletBrowserOnly } from "./placements/walletBrowserOnly.ts"
import { layerRefusalNoticeWith } from "./refusalNotice.ts"
import { layerRefusals, Refusals } from "./refusals.ts"
import { layerWalletFeed, type WalletOwner, walletOwner } from "./walletOwner.ts"

type A = typeof Auction

/**
 * What a page needs from a placement. A placement can fail with the decoding error of its settings.
 * `WorkerError` is in the type only because `RpcClient.layerProtocolWorker`'s signature carries it:
 * a worker that fails to start does not fail the layer, its calls hang or die with `RpcClientError`
 * and `Connection` reads `disconnected`.
 */
export type PagePorts = Layer.Layer<
  IntentPort<A> | ModelPort<A> | HistoryPort<A> | Whoami,
  Schema.SchemaError | WorkerError
>

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
const layerHeldNotice = layerHeldNoticeWith(html, render)

/** The time-travel panel; its row clicks call `TravelTo`, so only pages whose server serves it may mount it. */
export const layerTimeTravel = (): PageDevtools => layerPanel(Auction, Ports, { root: root("devtools") })

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

/** What the wallet's footer says about whose it is. */
const describeWalletOwner = (owner: WalletOwner) =>
  Option.match(owner, {
    onNone: () => "follows no bidder",
    onSome: (bidder) => `wallet of ${bidder}`
  })

/**
 * The wallet island: its own loop, root and placement (browser only). It follows the bidder the
 * placement's `Whoami` names (`layerWalletFeed` feeds it from the auction); a session the server
 * refuses leaves it mounted and never fed. The bidder is the page's claim to the leading bid and
 * nothing the server trusts depends on it. Its port never refuses, so its mount has nothing to report.
 */
const layerWallet = Layer.unwrap(
  walletOwner.pipe(
    Effect.map((owner) => {
      const view = layerMount(WalletPorts, {
        root: root("wallet"),
        view: makeWalletView(`${describeWalletOwner(owner)} · model:client,actions:client`),
        onRefused: () => Effect.void
      })
      return Layer.merge(view, layerWalletFeed(owner)).pipe(Layer.provide(walletBrowserOnly))
    })
  )
)

/**
 * Mounts the auction page over `placement`, labelled `label` (placement and identity), with
 * `devtools` beside the view and the wallet island below it, until the page is discarded.
 */
export const runPage = (placement: PagePorts, label: string, devtools: PageDevtools) => {
  const inspector = new URLSearchParams(location.search).get("inspect") === "1" ? makeInspector() : Layer.empty
  const page = Layer.mergeAll(
    layerMount(Ports, {
      root: root("app"),
      view: makeAuctionView(label),
      onRefused: (refused) => Refusals.use((refusals) => refusals.report(refused))
    }),
    layerWallet,
    layerConnectionBanner(stripAboveView()),
    layerHeldNotice(stripAboveView()),
    layerRefusalNotice(stripAboveView()),
    devtools,
    inspector
  ).pipe(Layer.provide(placement), Layer.provide(layerRefusals), Layer.provide(layerInputScheduler))
  BrowserRuntime.runMain(Layer.launch(page))
}
