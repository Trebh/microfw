import { Layer } from "effect"
import { runPage } from "./app.ts"
import { describeIdentity, parseIdentity } from "./placement.ts"
import { serverActions } from "./placements/serverActions.ts"

const identity = parseIdentity(location.search)

runPage(
  serverActions(identity.session),
  `model:client,actions:server · ${describeIdentity("server", identity)}`,
  Layer.empty
)
