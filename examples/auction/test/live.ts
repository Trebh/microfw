import assert from "node:assert/strict"
import { NodeRuntime, NodeSocket } from "@effect/platform-node"
import { createTestModel } from "@mufw/test"
import { Config, Console, Effect, Layer, Option, Stream } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { layerAuthenticationAnonymous, layerAuthenticationClient } from "../src/authentication.ts"
import { Auction } from "../src/domain/Auction.ts"
import { Amount, SessionToken } from "../src/domain/Values.ts"
import { Ports, Rpc } from "../src/ports.ts"
import { samPath } from "../src/samPath.ts"
import { auctionTestModel } from "./model.ts"

/**
 * Replays the auction's shortest paths against a live server, then checks that it takes the bidder
 * from the session. The server must run with `MUFW_AUTO_ACTIONS=off` (ticks cannot move the model)
 * and serve `Submit`, `Present`, `Representations`, `History` and `TravelTo`, which `pnpm dev:server` does.
 */
const ServerOrigin = Config.String("MUFW_SERVER").pipe(Config.withDefault("ws://localhost:3001"))

const model = createTestModel(Auction, Ports, auctionTestModel)

const Socket = Layer.unwrap(
  Effect.gen(function*() {
    return NodeSocket.layerWebSocket(`${yield* ServerOrigin}${samPath(Auction)}`)
  })
)

/** The RPC client over one connection; `authentication` decides which session its requests carry. */
const layerClient = (authentication: typeof layerAuthenticationAnonymous) =>
  Rpc.layerClient.pipe(
    Layer.provide(authentication),
    Layer.provide(RpcClient.layerProtocolSocket()),
    Layer.provide(Socket),
    Layer.provide(RpcSerialization.layerJson)
  )

const session = SessionToken.make("demo-alice")

const Remote = Layer.mergeAll(Rpc.layerModelRemote, Rpc.layerHistoryRemote, Rpc.layerIntentPortRemote).pipe(
  Layer.provide(layerClient(layerAuthenticationClient(session)))
)

const Anonymous = layerClient(layerAuthenticationAnonymous)

const replayPaths = Effect.forEach(
  model.shortestPaths(),
  (path) => model.run(path).pipe(Effect.andThen(Console.log(`ok ${model.describe(path)}`))),
  { discard: true }
).pipe(
  Effect.tapError((failure) => Console.error(`not ok ${failure.target} at step ${failure.stepIndex}: ${failure.message}`))
)

/** The accepted bid is the session's bidder's: the intent carries none. */
const bidAsSession = Effect.gen(function*() {
  const history = yield* Ports.HistoryPort
  const intents = yield* Ports.IntentPort
  const model = yield* Ports.ModelPort
  yield* history.travelTo(0).pipe(Effect.orDie)
  yield* intents.dispatch({ _tag: "Open" })
  yield* model.representations.pipe(Stream.filter((r) => r.controlState === "open"), Stream.runHead)
  yield* intents.dispatch({ _tag: "PlaceBid", amount: Amount.make(5) })
  const bid = yield* model.representations.pipe(Stream.filter((r) => Option.isSome(r.highest)), Stream.runHead)
  const bidders = Option.map(bid, (r) => Option.map(r.highest, (highest) => highest.bidder))
  assert.deepStrictEqual(bidders, Option.some(Option.some("alice")))
  yield* Console.log("ok bid is attributed to the session's bidder")
}).pipe(Effect.timeout("5 seconds"))

/** A client without a session cannot make the server run an action. */
const refusedWithoutSession = Rpc.Client.use((client) => client.Submit({ _tag: "Open" })).pipe(
  Effect.flip,
  Effect.tap((error) => Effect.sync(() => assert.strictEqual(error._tag, "Unauthenticated"))),
  Effect.andThen(Console.log("ok a request without a session is refused"))
)

const program = Effect.all([
  replayPaths.pipe(Effect.andThen(bidAsSession), Effect.provide(Remote)),
  refusedWithoutSession.pipe(Effect.provide(Anonymous))
], { discard: true })

NodeRuntime.runMain(program)
