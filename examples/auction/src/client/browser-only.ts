import { Layer } from "effect"
import { runPage } from "./app.ts"
import { describeIdentity, parseIdentity } from "./placement.ts"
import { browserOnly } from "./placements/browserOnly.ts"

const identity = parseIdentity(location.search)

runPage(
  browserOnly(identity.bidder),
  `model:client,actions:client · ${describeIdentity("client", identity)}`,
  Layer.empty
)
