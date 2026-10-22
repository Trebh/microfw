import { Layer } from "effect"
import { runPage } from "./app.ts"
import { describeIdentity, parseIdentity } from "./placement.ts"
import { serverOwned } from "./placements/serverOwned.ts"

const identity = parseIdentity(location.search)

runPage(
  serverOwned(identity.session),
  `model:server,actions:server · ${describeIdentity("server", identity)}`,
  Layer.empty
)
