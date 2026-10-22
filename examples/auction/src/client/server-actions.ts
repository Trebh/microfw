import { Layer } from "effect"
import { runPage } from "./app.ts"
import { pageLabels } from "./labels.ts"
import { parseIdentity, parseWalletOwner } from "./placement.ts"
import { serverActions } from "./placements/serverActions.ts"

const identity = parseIdentity(location.search)

runPage(
  serverActions(identity.session),
  pageLabels["server-actions"](location.search),
  Layer.empty,
  parseWalletOwner("server", location.search)
)
