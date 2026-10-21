import { Layer } from "effect"
import { Rpc } from "../../ports.ts"
import { transport } from "./transport.ts"

/**
 * The server owns model and actions; the browser submits intents and streams representations.
 * Needs the server to serve `Submit`, `Representations`, `History` (and `TravelTo` for the panel).
 */
export const serverOwned = () =>
  Layer.mergeAll(Rpc.layerIntentPortRemote, Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(
    Layer.provide(transport())
  )
