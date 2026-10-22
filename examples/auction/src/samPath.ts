/**
 * The websocket path a definition's RPCs are served on. Each served definition has its own path, so
 * the RPC tags stay those of the wire contract and a request needs no definition name.
 */
export const samPath = (def: { readonly name: string }): `/sam/${string}` => `/sam/${def.name}`

/** The path of a definition's read-only RPCs over HTTP (`POST`, NDJSON), beside its websocket path. */
export const samHttpPath = (def: { readonly name: string }): `/sam/${string}/http` => `${samPath(def)}/http`

/** The path of a definition's view streamed as HTML (`GET`), which an `<iframe>` shows with no script of its own. */
export const samStreamPath = (def: { readonly name: string }): `/stream/${string}` => `/stream/${def.name}`
