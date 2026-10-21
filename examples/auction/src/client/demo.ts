import { runPage } from "./app.ts"
import { formatPlacement, parsePlacement } from "./placement.ts"
import { browserOnly } from "./placements/browserOnly.ts"
import { serverActions } from "./placements/serverActions.ts"
import { serverModel } from "./placements/serverModel.ts"
import { serverOwned } from "./placements/serverOwned.ts"

/** The demo page picks any placement from the URL at runtime, so it bundles all four. */
const placements = {
  "client/client": browserOnly,
  "server/server": serverOwned,
  "server/client": serverModel,
  "client/server": serverActions
}

const placement = parsePlacement(location.search)

runPage(placements[`${placement.model}/${placement.actions}`](), `demo ${formatPlacement(placement)}`)
