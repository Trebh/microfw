import { Layer } from "effect"
import { runPage } from "./app.ts"
import { pageLabels } from "./labels.ts"
import { parseIdentity, parseWalletOwner } from "./placement.ts"
import { browserOnly } from "./placements/browserOnly.ts"

const identity = parseIdentity(location.search)

runPage(
  browserOnly(identity.bidder),
  pageLabels["browser-only"](location.search),
  Layer.empty,
  parseWalletOwner("client", location.search)
)
