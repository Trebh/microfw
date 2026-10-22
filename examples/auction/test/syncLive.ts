import assert from "node:assert/strict"
import { NodeRuntime, NodeSocket } from "@effect/platform-node"
import { Config, Console, Context, Effect, Layer, Option, Stream } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { layerAuthenticationClient } from "../src/authentication.ts"
import { Auction } from "../src/domain/Auction.ts"
import { Amount, SessionToken } from "../src/domain/Values.ts"
import { Ports, Rpc } from "../src/ports.ts"
import { samPath } from "../src/samPath.ts"

/**
 * Two servers that share an event log (`MUFW_SYNC=host` on the first, `MUFW_SYNC=ws://…/eventlog`
 * on the second) must show the same auction: a bid made through either is on both, and two bids
 * made at once end in the same order on both. The servers need `Submit` and `Representations`
 * (the defaults); only the host runs automatic actions, so the auction opens by itself.
 */
const Host = Config.String("MUFW_SERVER").pipe(Config.withDefault("ws://localhost:3001"))
const Joiner = Config.String("MUFW_SERVER_2").pipe(Config.withDefault("ws://localhost:3002"))

/** One server's remote ports over their own connection, acting as the bidder that owns `session`. */
const connect = (origin: string, session: string) => {
  const client = Rpc.layerClient.pipe(
    Layer.provide(layerAuthenticationClient(SessionToken.make(session))),
    Layer.provide(RpcClient.layerProtocolSocket()),
    Layer.provide(NodeSocket.layerWebSocket(`${origin}${samPath(Auction)}`)),
    Layer.provide(RpcSerialization.layerJson)
  )
  return Layer.build(Layer.mergeAll(Rpc.layerModelRemote, Rpc.layerIntentPortRemote).pipe(Layer.provide(client)))
}

const program = Effect.gen(function*() {
  const first = yield* connect(yield* Host, "demo-alice")
  const second = yield* connect(yield* Joiner, "demo-bob")
  const onFirst = Context.get(first, Ports.ModelPort)
  const onSecond = Context.get(second, Ports.ModelPort)
  yield* onSecond.representations.pipe(Stream.filter((r) => r.controlState === "open"), Stream.runHead)

  yield* Context.get(first, Ports.IntentPort).dispatch({ _tag: "PlaceBid", amount: Amount.make(5) })
  const placed = yield* onSecond.representations.pipe(Stream.filter((r) => r.bids.length >= 1), Stream.runHead)
  assert.deepStrictEqual(Option.getOrThrow(placed).bids.map((bid) => bid.bidder), ["alice"])
  yield* Console.log("ok a bid on the first server is on the second")

  yield* Effect.all([
    Context.get(first, Ports.IntentPort).dispatch({ _tag: "PlaceBid", amount: Amount.make(30) }),
    Context.get(second, Ports.IntentPort).dispatch({ _tag: "PlaceBid", amount: Amount.make(40) })
  ], { concurrency: "unbounded" })
  yield* Effect.sleep("1 second")
  const bidsFirst = Option.getOrThrow(yield* Stream.runHead(onFirst.representations)).bids
  const bidsSecond = Option.getOrThrow(yield* Stream.runHead(onSecond.representations)).bids
  assert.deepStrictEqual(bidsFirst, bidsSecond)
  yield* Console.log(`ok both servers hold the same bids: ${bidsFirst.map((bid) => `${bid.bidder}:${bid.amount}`).join(" ")}`)
}).pipe(Effect.scoped, Effect.timeout("20 seconds"))

NodeRuntime.runMain(program)
