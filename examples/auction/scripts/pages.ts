/**
 * Each deployment is built on its own, with its page as the only entry, so its bundle holds only the
 * placement that deployment composes. The demo page bundles all four placements by design.
 */
export const pages: Readonly<Record<string, string>> = {
  "demo": "index.html",
  "browser-only": "browser-only.html",
  "server-owned": "server-owned.html",
  "server-model": "server-model.html",
  "server-actions": "server-actions.html",
  "devtools": "devtools.html",
  "worker": "worker.html"
}
