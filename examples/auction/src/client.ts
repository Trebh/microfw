import { BrowserRuntime, BrowserSocket } from "@effect/platform-browser"
import { exploreGraph, layerActionRunnerLocal, layerActionsDrain, layerIntentBus, layerModelLocal, toXStateDefinition } from "@mufw/core"
import { layerPanel, layerStately } from "@mufw/devtools"
import { layerMount } from "@mufw/view-uhtml"
import { createBrowserInspector } from "@statelyai/inspect"
import { Layer } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Auction, exploreAuction, serializeAuction } from "./domain/Auction.ts"
import { CreditCheck } from "./domain/CreditCheck.ts"
import { formatPlacement, parsePlacement } from "./placement.ts"
import { Ports, Rpc } from "./ports.ts"
import { makeView } from "./view.ts"

const SERVER_URL = "ws://localhost:3001/sam"

const placement = parsePlacement(location.search)

/** One shared connection: the same layer value is built once however many remote ports use it. */
const Transport = Rpc.layerClient.pipe(
  Layer.provide(RpcClient.layerProtocolSocket()),
  Layer.provide(BrowserSocket.layerWebSocket(SERVER_URL)),
  Layer.provide(RpcSerialization.layerJson)
)

const ModelLayer = placement.model === "client"
  ? layerModelLocal(Auction, Ports)
  : Layer.merge(Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(Layer.provide(Transport))

const RunnerLayer = placement.actions === "client"
  ? layerActionRunnerLocal(Auction, Ports).pipe(Layer.provide(CreditCheck.layerPermissive))
  : Rpc.layerActionRunnerRemote.pipe(Layer.provide(Transport))

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

const Inspector = new URLSearchParams(location.search).get("inspect") === "1" ? makeInspector() : Layer.empty

const App = Layer.mergeAll(
  layerMount(Ports, { root: root("app"), view: makeView(placement.bidder, formatPlacement(placement)) }),
  layerPanel(Ports, { root: root("devtools") }),
  Inspector,
  layerActionsDrain(Auction, Ports)
).pipe(
  Layer.provideMerge(Layer.merge(ModelLayer, RunnerLayer)),
  Layer.provideMerge(layerIntentBus(Auction, Ports))
)

BrowserRuntime.runMain(Layer.launch(App))
