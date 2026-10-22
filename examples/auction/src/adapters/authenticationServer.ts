import { Unauthenticated } from "@mufw/rpc"
import { Effect, Layer, Option, Schema } from "effect"
import { Headers } from "effect/http"
import { Authentication, SESSION_HEADER } from "../authentication.ts"
import { CurrentBidder } from "../domain/CurrentBidder.ts"
import { Sessions } from "../domain/Sessions.ts"
import { SessionToken } from "../domain/Values.ts"

const decodeToken = Schema.decodeUnknownOption(SessionToken)

const refuse = (message: string) => Effect.fail(new Unauthenticated({ message }))

/** The server's side of `Authentication`: the token in the request header is looked up in `Sessions`. */
export const layerAuthenticationServer = Layer.effect(
  Authentication,
  Effect.gen(function*() {
    const sessions = yield* Sessions
    return (handler, { headers }) =>
      Effect.gen(function*() {
        const token = yield* Option.match(Headers.get(headers, SESSION_HEADER).pipe(Option.flatMap(decodeToken)), {
          onNone: () => refuse("No session"),
          onSome: Effect.succeed
        })
        const bidder = yield* Effect.flatMap(
          sessions.authenticate(token),
          Option.match({ onNone: () => refuse("Unknown session"), onSome: Effect.succeed })
        )
        return yield* Effect.provideService(handler, CurrentBidder, { bidder })
      })
  })
)
