import { Layer } from "effect"
import { runPage } from "./app.ts"
import { pageLabels } from "./labels.ts"
import { parseIdentity, parseWalletOwner } from "./placement.ts"
import { serverModel } from "./placements/serverModel.ts"

const identity = parseIdentity(location.search)

runPage(
  serverModel(identity.bidder),
  pageLabels["server-model"](location.search),
  Layer.empty,
  parseWalletOwner("client", location.search)
)
