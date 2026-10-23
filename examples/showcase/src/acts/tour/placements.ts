import { BrowserWorker } from "@effect/platform-browser"
import { layerLoopLocal } from "@mufw/core"
import { Layer } from "effect"
import { RpcClient } from "effect/rpc"
import { backstage } from "./backstage.ts"
import { layerWorkerConnection } from "./connection.ts"
import { layerLatency } from "./doors.ts"
import { house, town, townRpc, wingsRpc } from "./stages.ts"

/** What the stand-in for the road costs every intent, and what the card says it costs. */
export const NETWORK_MILLIS = 180

export const inTheHouse = layerLoopLocal(house.def, house.ports).pipe(
  Layer.provide(backstage)
)

// A streaming request holds its lease on the worker until it ends, so a limit of one would let the
// first open `Representations` stream starve every other call.
const workerProtocol = RpcClient.layerProtocolWorker({ size: 1, concurrency: Number.MAX_SAFE_INTEGER }).pipe(
  Layer.provideMerge(layerWorkerConnection),
  Layer.orDie
)

const wingsRemote = Layer.mergeAll(
  wingsRpc.layerIntentPortRemote,
  wingsRpc.layerModelRemote,
  wingsRpc.layerHistoryRemote
).pipe(
  Layer.provideMerge(wingsRpc.layerClient)
)

/** The `new Worker(new URL(...))` form is what the bundler recognises to emit the worker as its own file. */
const spawnWings = () =>
  new Worker(
    new URL("./company.worker.ts", import.meta.url),
    { type: "module" }
  )

/** Three remote ports over a worker's message channel; the model and its actions live in `company.worker.ts`. */
export const inTheWings = wingsRemote.pipe(
  Layer.provideMerge(workerProtocol),
  Layer.provide(BrowserWorker.layer(spawnWings))
)

const townLoop = layerLoopLocal(town.def, town.ports).pipe(
  Layer.provide(backstage)
)

const townClient = townRpc.layerClientTest.pipe(
  Layer.provide(townRpc.layerHandlers),
  Layer.provide(townLoop)
)

const townRemote = Layer.mergeAll(
  layerLatency(town, NETWORK_MILLIS).pipe(Layer.provide(townRpc.layerIntentPortRemote)),
  townRpc.layerModelRemote,
  townRpc.layerHistoryRemote
)

/** Three remote ports over a client wired to the server's handlers in this page, with a road in between. */
export const acrossTown = townRemote.pipe(Layer.provide(townClient))
