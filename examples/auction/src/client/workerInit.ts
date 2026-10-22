import { Schema } from "effect"
import { Bidder } from "../domain/Values.ts"

/**
 * What a page tells its worker when it starts it, since the worker cannot read the page's URL. The
 * page encodes it as the RPC protocol's initial message; the worker decodes it once, at its
 * composition root, into the identity it acts under.
 */
export const WorkerInit = Schema.Struct({ bidder: Bidder })
