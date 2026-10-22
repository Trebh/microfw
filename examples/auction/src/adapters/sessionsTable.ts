import { Effect, Layer, Option } from "effect"
import { Sessions } from "../domain/Sessions.ts"
import { Bidder } from "../domain/Values.ts"

/** Demo sessions: a fixed table of tokens, each owned by one bidder. A `Map`, so `constructor` is not a token. */
const SESSIONS = new Map<string, Bidder>([
  ["demo-alice", Bidder.make("alice")],
  ["demo-bob", Bidder.make("bob")]
])

export const layerSessionsTable = Layer.succeed(Sessions, {
  authenticate: (token) => Effect.succeed(Option.fromNullishOr(SESSIONS.get(token)))
})
