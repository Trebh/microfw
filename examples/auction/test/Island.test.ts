import { assert, describe, it } from "@effect/vitest"
import { layerForward, layerLoopLocal } from "@mufw/core"
import { Effect, Layer, Option, Stream } from "effect"
import { Amount, Bidder } from "../src/domain/Values.ts"
import { holdForBids } from "../src/domain/WalletFeed.ts"
import { type Representation, Wallet } from "../src/domain/Wallet.ts"
import { Ports, WalletPorts } from "../src/ports.ts"
import { Local } from "./drivers.ts"

const alice = Bidder.make("alice")
const bob = Bidder.make("bob")

/** The auction's local loop as alice, the wallet's own loop, and the wallet following the auction. */
const Island = layerForward(Ports, WalletPorts, holdForBids(alice)).pipe(
  Layer.provideMerge(Layer.merge(Local, layerLoopLocal(Wallet, WalletPorts)))
)

const walletShows = (predicate: (representation: Representation) => boolean) =>
  WalletPorts.ModelPort.use((wallet) => wallet.representations.pipe(Stream.filter(predicate), Stream.runHead)).pipe(
    Effect.map(Option.getOrThrow)
  )

const openAuction = Ports.ModelPort.use((auction) => auction.present({ _tag: "Opened", at: 0 }))

const aliceBids = (amount: number) =>
  Ports.IntentPort.use((intents) => intents.dispatch({ _tag: "PlaceBid", amount: Amount.make(amount) }))

describe("auction and wallet islands", () => {
  it.effect("an accepted bid reserves its amount in the wallet", () =>
    Effect.gen(function*() {
      yield* openAuction

      yield* aliceBids(40)
      const wallet = yield* walletShows((representation) => representation.reserved === 40)

      assert.deepStrictEqual(wallet, { controlState: "funded", credit: 100, reserved: 40, available: 60 })
    }).pipe(Effect.provide(Island)))

  it.effect("a bid that uses the whole credit exhausts the wallet", () =>
    Effect.gen(function*() {
      yield* openAuction

      yield* aliceBids(100)
      const wallet = yield* walletShows((representation) => representation.reserved === 100)

      assert.deepStrictEqual(wallet, { controlState: "exhausted", credit: 100, reserved: 100, available: 0 })
    }).pipe(Effect.provide(Island)))

  it.effect("another bidder's bid releases the reservation", () =>
    Effect.gen(function*() {
      yield* openAuction
      yield* aliceBids(40)
      yield* walletShows((representation) => representation.reserved === 40)

      yield* Ports.ModelPort.use((auction) => auction.present({ _tag: "Bid", bidder: bob, amount: Amount.make(45), at: 0 }))
      const wallet = yield* walletShows((representation) => representation.reserved === 0)

      assert.deepStrictEqual(wallet, { controlState: "funded", credit: 100, reserved: 0, available: 100 })
    }).pipe(Effect.provide(Island)))

  it.effect("a leading bid above the wallet's credit releases what the previous bid held", () =>
    Effect.gen(function*() {
      yield* openAuction
      yield* aliceBids(40)
      yield* walletShows((representation) => representation.reserved === 40)

      yield* Ports.ModelPort.use((auction) =>
        auction.present({ _tag: "Bid", bidder: alice, amount: Amount.make(150), at: 0 })
      )
      const wallet = yield* walletShows((representation) => representation.reserved === 0)

      assert.deepStrictEqual(wallet, { controlState: "funded", credit: 100, reserved: 0, available: 100 })
    }).pipe(Effect.provide(Island)))
})
