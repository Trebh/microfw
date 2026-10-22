import { layerTimeTravel, runPage } from "./app.ts"
import { describeIdentity, formatPlacement, parseIdentity, parsePlacement } from "./placement.ts"
import { browserOnly } from "./placements/browserOnly.ts"
import { serverActions } from "./placements/serverActions.ts"
import { serverModel } from "./placements/serverModel.ts"
import { serverOwned } from "./placements/serverOwned.ts"

const identity = parseIdentity(location.search)

/** The demo page picks any placement from the URL at runtime, so it bundles all four. */
const placements = {
  "client/client": () => browserOnly(identity.bidder),
  "server/server": () => serverOwned(identity.session),
  "server/client": () => serverModel(identity.bidder),
  "client/server": () => serverActions(identity.session)
}

const placement = parsePlacement(location.search)

runPage(
  placements[`${placement.model}/${placement.actions}`](),
  `demo ${formatPlacement(placement)} · ${describeIdentity(placement.actions, identity)}`,
  layerTimeTravel()
)
