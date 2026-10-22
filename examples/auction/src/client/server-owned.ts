import { Layer } from "effect"
import { runPage } from "./app.ts"
import { pageLabels } from "./labels.ts"
import { parseIdentity, parseWalletOwner } from "./placement.ts"
import { serverOwned } from "./placements/serverOwned.ts"

const identity = parseIdentity(location.search)

runPage(
  serverOwned(identity.session),
  pageLabels["server-owned"](location.search),
  Layer.empty,
  parseWalletOwner("server", location.search)
)
