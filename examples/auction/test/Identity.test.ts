import { assert, describe, it } from "@effect/vitest"
import { AutoActions, type DispatchRefused, type IntentPort, layerLoopLocal } from "@mufw/core"
import { Effect, Layer, Option, Stream } from "effect"
import { expectTypeOf } from "vitest"
import { layerCreditCheckTable } from "../src/adapters/creditCheckTable.ts"
import { layerCurrentBidderFixed } from "../src/adapters/currentBidderFixed.ts"
import { layerAuthenticationAnonymous, layerAuthenticationClient } from "../src/authentication.ts"
import { Auction, type Representation } from "../src/domain/Auction.ts"
import type { CurrentBidder } from "../src/domain/CurrentBidder.ts"
import { Amount, Bidder, SessionToken } from "../src/domain/Values.ts"
import { Ports, Rpc } from "../src/ports.ts"
import { ServerPorts, ServerRpc } from "../src/serverPorts.ts"
import { clientWith } from "./serverSide.ts"

const noAutoActions = Layer.succeed(AutoActions, false)

const withSession = (token: string) => clientWith(layerAuthenticationClient(SessionToken.make(token)))

/** A page's intent port over the wire; it does not see the server's own ports. */
const intentsWith = (authentication: typeof layerAuthenticationAnonymous) =>
  Rpc.layerIntentPortRemote.pipe(Layer.provide(clientWith(authentication)))

const placeBid = (amount: number) => ({ _tag: "PlaceBid", amount: Amount.make(amount) }) as const

const awaitRepresentation = (predicate: (representation: Representation) => boolean) =>
  Ports.ModelPort.use((port) => port.representations.pipe(Stream.filter(predicate), Stream.runHead)).pipe(
    Effect.map(Option.getOrThrow)
  )

const highestBidder = (representation: Representation) => Option.map(representation.highest, (bid) => bid.bidder)

describe("an RPC that runs actions", () => {
  it.effect("Dispatch without a session fails Unauthenticated", () =>
    Effect.gen(function*() {
      const refused = yield* Rpc.Client.use((client) => client.Dispatch(placeBid(5))).pipe(Effect.flip)

      assert.deepStrictEqual([refused._tag, refused.message], ["Unauthenticated", "No session"])
    }).pipe(Effect.provide(clientWith(layerAuthenticationAnonymous))))

  it.effect("Submit without a session fails Unauthenticated", () =>
    Effect.gen(function*() {
      const refused = yield* Rpc.Client.use((client) => client.Submit({ _tag: "Open" })).pipe(Effect.flip)

      assert.deepStrictEqual([refused._tag, refused.message], ["Unauthenticated", "No session"])
    }).pipe(Effect.provide(clientWith(layerAuthenticationAnonymous))))

  it.effect("Dispatch with an unknown session fails Unauthenticated", () =>
    Effect.gen(function*() {
      const refused = yield* Rpc.Client.use((client) => client.Dispatch(placeBid(5))).pipe(Effect.flip)

      assert.deepStrictEqual([refused._tag, refused.message], ["Unauthenticated", "Unknown session"])
    }).pipe(Effect.provide(withSession("demo-mallory"))))

  it.effect("Dispatch with a session proposes the bid as the session's bidder", () =>
    Effect.gen(function*() {
      const proposal = yield* Rpc.Client.use((client) => client.Dispatch(placeBid(101)))

      assert.deepStrictEqual(proposal, { _tag: "Bid", bidder: Bidder.make("bob"), amount: Amount.make(101), at: 0 })
    }).pipe(Effect.provide(withSession("demo-bob"))))

  it.effect("Dispatch ignores a bidder the client puts in the payload", () =>
    Effect.gen(function*() {
      const forged = { ...placeBid(101), bidder: Bidder.make("alice") }

      const proposal = yield* Rpc.Client.use((client) => client.Dispatch(forged))

      assert.deepStrictEqual(proposal, { _tag: "Bid", bidder: Bidder.make("bob"), amount: Amount.make(101), at: 0 })
    }).pipe(Effect.provide(withSession("demo-bob"))))

  it.live("Submit runs the server's action as the session's bidder", () =>
    Effect.gen(function*() {
      yield* Rpc.Client.use((client) => client.Submit({ _tag: "Open" }))
      yield* awaitRepresentation((representation) => representation.controlState === "open")

      yield* Rpc.Client.use((client) => client.Submit(placeBid(101)))
      const bid = yield* awaitRepresentation((representation) => Option.isSome(representation.highest))

      assert.deepStrictEqual(highestBidder(bid), Option.some(Bidder.make("bob")))
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(withSession("demo-bob"))))
})

describe("a page whose server runs the actions", () => {
  const refusedOpen = Ports.IntentPort.use((intents) => intents.dispatch({ _tag: "Open" })).pipe(Effect.flip)

  it.effect("a dispatch without a session fails DispatchRefused", () =>
    Effect.gen(function*() {
      const refused = yield* refusedOpen

      assert.deepStrictEqual(
        [refused._tag, refused.intentTag, refused.message],
        ["DispatchRefused", "Open", "No session"]
      )
    }).pipe(Effect.provide(intentsWith(layerAuthenticationAnonymous))))

  it.effect("a dispatch with an unknown session fails DispatchRefused", () =>
    Effect.gen(function*() {
      const refused = yield* refusedOpen

      assert.deepStrictEqual([refused._tag, refused.message], ["DispatchRefused", "Unknown session"])
    }).pipe(Effect.provide(intentsWith(layerAuthenticationClient(SessionToken.make("demo-mallory"))))))
})

describe("the server's ports in the types", () => {
  it("a dispatch needs the bidder that the middleware provides per request", () => {
    const dispatch = ServerPorts.IntentPort.use((intents) => intents.dispatch({ _tag: "Open" }))

    expectTypeOf(dispatch).toEqualTypeOf<
      Effect.Effect<void, DispatchRefused, IntentPort<typeof Auction> | CurrentBidder>
    >()
  })

  it("the handlers need nothing from the request: the middleware provides the bidder", () => {
    type Needed = Layer.Services<typeof ServerRpc.layerHandlers>

    expectTypeOf<CurrentBidder>().not.toExtend<Needed>()
  })
})

describe("a page that runs its own actions", () => {
  const Local = (bidder: string) =>
    layerLoopLocal(Auction, Ports).pipe(
      Layer.provide(Layer.merge(layerCreditCheckTable, layerCurrentBidderFixed(Bidder.make(bidder)))),
      Layer.provide(noAutoActions)
    )

  it.effect("bids as the identity its composition root provides", () =>
    Effect.gen(function*() {
      const intents = yield* Ports.IntentPort
      yield* intents.dispatch({ _tag: "Open" })
      yield* awaitRepresentation((representation) => representation.controlState === "open")

      yield* intents.dispatch(placeBid(101))
      const bid = yield* awaitRepresentation((representation) => Option.isSome(representation.highest))

      assert.deepStrictEqual(highestBidder(bid), Option.some(Bidder.make("bob")))
    }).pipe(Effect.provide(Local("bob"))))
})
