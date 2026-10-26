import { assert, describe, it } from "@effect/vitest"
import { layerLoopLocal } from "@mufw/core"
import { Effect, Layer, Option, Stream } from "effect"
import { layerWalletFeed, walletOwner } from "../src/client/walletOwner.ts"
import { layerAuthenticationClient, type layerAuthenticationAnonymous } from "../src/authentication.ts"
import { Amount, Bidder, SessionToken } from "../src/domain/Values.ts"
import { type Representation, Wallet } from "../src/wallet/Wallet.ts"
import { Ports, Rpc, WalletPorts } from "../src/ports.ts"
import { clientWith, whoamiWith } from "./serverSide.ts"

const session = (token: string) => layerAuthenticationClient(SessionToken.make(token))

/**
 * A page whose server owns the auction and the actions, with the server side in-process: the ports
 * are remote, the wallet is the page's own loop, and the feed follows whoever `Whoami` names. No
 * page here states a bidder.
 */
const serverOwnedPage = (authentication: typeof layerAuthenticationAnonymous) =>
  Layer.unwrap(Effect.map(walletOwner, layerWalletFeed)).pipe(
    Layer.provideMerge(layerLoopLocal(Wallet, WalletPorts)),
    Layer.provideMerge(Layer.merge(Rpc.layerIntentPortRemote, Rpc.layerModelRemote).pipe(
      Layer.provide(clientWith(authentication))
    )),
    Layer.provideMerge(whoamiWith(authentication))
  )

const walletShows = (predicate: (representation: Representation) => boolean) =>
  WalletPorts.ModelPort.use((wallet) => wallet.representations.pipe(Stream.filter(predicate), Stream.runHead)).pipe(
    Effect.map(Option.getOrThrow)
  )

const auctionOpen = Ports.ModelPort.use((auction) =>
  auction.representations.pipe(Stream.filter((representation) => representation.controlState === "open"), Stream.runHead)
)

describe("walletOwner", () => {
  it.effect("is the bidder the server names for the session", () =>
    Effect.gen(function*() {
      const owner = yield* walletOwner

      assert.deepStrictEqual(owner, Option.some(Bidder.make("bob")))
    }).pipe(Effect.provide(whoamiWith(session("demo-bob")))))

  it.effect("is none for a session the server refuses", () =>
    Effect.gen(function*() {
      const owner = yield* walletOwner

      assert.deepStrictEqual(owner, Option.none())
    }).pipe(Effect.provide(whoamiWith(session("demo-mallory")))))
})

describe("the wallet of a page whose server runs the actions", () => {
  it.live("reserves the bid the session's bidder placed", () =>
    Effect.gen(function*() {
      yield* Ports.IntentPort.use((intents) => intents.dispatch({ _tag: "Open" }))
      yield* auctionOpen

      yield* Ports.IntentPort.use((intents) => intents.dispatch({ _tag: "PlaceBid", amount: Amount.make(40) }))
      const wallet = yield* walletShows((representation) => representation.reserved === 40)

      assert.deepStrictEqual(wallet, { controlState: "funded", credit: 100, reserved: 40, available: 60 })
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(serverOwnedPage(session("demo-bob")))))
})
