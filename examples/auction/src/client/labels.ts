import { type Deployment, type Placement, placements } from "../deployments.ts"
import { describeIdentity, formatPlacement, parseIdentity, parsePlacement } from "./placement.ts"

const describePage = (placement: Placement, search: string) =>
  `${formatPlacement(placement)} · ${describeIdentity(placement.actions, parseIdentity(search))}`

const labelOf = (placement: Placement) => (search: string) => describePage(placement, search)

/**
 * What each page's footer says about its placement and identity, from the page's query string. The
 * page entries and the server-rendered first paint both read it, so the markup the server sends is
 * the markup the browser renders again. A fixed page says the placement declared in `placements`;
 * the demo says the one in its query string.
 */
export const pageLabels: Readonly<Record<Deployment, (search: string) => string>> = {
  "demo": (search) => `demo ${describePage(parsePlacement(search), search)}`,
  "browser-only": labelOf(placements["browser-only"]),
  "server-owned": labelOf(placements["server-owned"]),
  "server-model": labelOf(placements["server-model"]),
  "server-actions": labelOf(placements["server-actions"])
}
