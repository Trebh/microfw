import { Layer } from "effect"
import { runPage } from "./app.ts"
import { describeIdentity, parseIdentity } from "./placement.ts"
import { serverModel } from "./placements/serverModel.ts"

const identity = parseIdentity(location.search)

runPage(
  serverModel(identity.bidder),
  `model:server,actions:client · ${describeIdentity("client", identity)}`,
  Layer.empty
)
