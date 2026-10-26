import { Schema } from "effect"

/**
 * The deployments whose page shows the auction view and whose first paint the server can render
 * (`MUFW_SSR`): they start from the server's model. The worker page starts from a model of its own,
 * the devtools page has no auction view.
 */
export const deployments = ["demo", "browser-only", "server-owned", "server-model", "server-actions"] as const

export type Deployment = (typeof deployments)[number]

export const Side = Schema.Literals(["client", "server"])
export type Side = typeof Side.Type

/** Where a page's auction model lives and where its actions run. */
export interface Placement {
  readonly model: Side
  readonly actions: Side
}

/** A deployment whose placement is fixed; the demo page's comes from its query string. */
export type PlacedDeployment = Exclude<Deployment, "demo">

/**
 * The placement of each fixed deployment, declared once: its footer says it (`client/labels.ts`),
 * and `scripts/check-bundle.ts` expects its bundle to ship the auction's local halves exactly for
 * the sides that are `client`. The composition in `client/placements/` is written to match.
 */
export const placements: Readonly<Record<PlacedDeployment, Placement>> = {
  "browser-only": { model: "client", actions: "client" },
  "server-owned": { model: "server", actions: "server" },
  "server-model": { model: "server", actions: "client" },
  "server-actions": { model: "client", actions: "server" }
}
