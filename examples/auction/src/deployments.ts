/**
 * The deployments whose page shows the auction view and whose first paint the server can render
 * (`MUFW_SSR`): they start from the server's model. The worker page starts from a model of its own,
 * the devtools page has no auction view.
 */
export const deployments = ["demo", "browser-only", "server-owned", "server-model", "server-actions"] as const

export type Deployment = (typeof deployments)[number]
