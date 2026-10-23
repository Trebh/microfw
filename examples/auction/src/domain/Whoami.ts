import type { Unauthenticated } from "@mufw/rpc"
import { Context, type Effect } from "effect"
import type { Bidder } from "./Values.ts"

/**
 * Whose page this is, as the page can learn it: a page whose server runs the actions asks the
 * server, which answers from the session the page sends; a page that runs its own actions names its
 * bidder itself. Port only, so an island that depends on the bidder (the wallet) needs no claim of
 * its own. A session the server does not know fails with `Unauthenticated`.
 */
export class Whoami extends Context.Service<Whoami, {
  readonly bidder: Effect.Effect<Bidder, Unauthenticated>
}>()("auction/Whoami") {}
