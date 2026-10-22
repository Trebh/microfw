import type { Deployment } from "../deployments.ts"
import { describeIdentity, formatPlacement, parseIdentity, parsePlacement } from "./placement.ts"

/**
 * What each page's footer says about its placement and identity, from the page's query string. The
 * page entries and the server-rendered first paint both read it, so the markup the server sends is
 * the markup the browser renders again.
 */
export const pageLabels: Readonly<Record<Deployment, (search: string) => string>> = {
  "demo": (search) => {
    const placement = parsePlacement(search)
    return `demo ${formatPlacement(placement)} · ${describeIdentity(placement.actions, parseIdentity(search))}`
  },
  "browser-only": (search) => `model:client,actions:client · ${describeIdentity("client", parseIdentity(search))}`,
  "server-owned": (search) => `model:server,actions:server · ${describeIdentity("server", parseIdentity(search))}`,
  "server-model": (search) => `model:server,actions:client · ${describeIdentity("client", parseIdentity(search))}`,
  "server-actions": (search) => `model:client,actions:server · ${describeIdentity("server", parseIdentity(search))}`
}
