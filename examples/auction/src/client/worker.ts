import { layerTimeTravel, runPage } from "./app.ts"
import { describeIdentity, parseIdentity, parseWalletOwner } from "./placement.ts"
import { inWorker } from "./placements/worker.ts"

const identity = parseIdentity(location.search)

// The worker runs the actions, so the page's `?bidder=` is the identity of both, as in the browser-only page.
runPage(
  inWorker(identity.bidder),
  `model:worker,actions:worker · ${describeIdentity("client", identity)}`,
  layerTimeTravel(),
  parseWalletOwner("client", location.search)
)
