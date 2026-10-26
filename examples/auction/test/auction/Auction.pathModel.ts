import { assert } from "@effect/vitest"
import {
  AutoActions,
  type DispatchRefused,
  type IntentPort,
  layerLoopLocal,
  type ModelPort,
  type PathStep
} from "@mufw/core"
import { createTestModel, type Driver, intentDriver, type TestModelOptions } from "@mufw/test"
import { Effect, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { layerCreditCheckTable } from "../../src/adapters/creditCheckTable.ts"
import { layerCurrentBidderFixed } from "../../src/adapters/currentBidderFixed.ts"
import { exploreAuction, serializeAuction } from "../../src/auction/Auction.explore.ts"
import { AUCTION_LENGTH, Auction, type Intent } from "../../src/auction/Auction.ts"
import { Amount, Bidder } from "../../src/domain/Values.ts"
import { Ports } from "../../src/ports.ts"

/** The auction's test model: exploration alphabet plus one assertion per control state. */
export const auctionTestModel: TestModelOptions<typeof Auction> = {
  explore: exploreAuction,
  serialize: serializeAuction,
  states: {
    opening: (representation) => {
      assert.strictEqual(representation.controlState, "opening")
      assert.strictEqual(representation.remainingSeconds, 60)
    },
    open: (representation) => {
      assert.ok(representation.remainingSeconds > 10, `${representation.remainingSeconds}s left`)
      assert.strictEqual(representation.controlState, "open")
    },
    closing: (representation) => {
      assert.ok(representation.remainingSeconds <= 10, `${representation.remainingSeconds}s left`)
    },
    sold: (representation) => {
      assert.strictEqual(representation.remainingSeconds, 0)
      assert.strictEqual(representation.controlState, "sold")
    }
  }
}

export const auctionModel = createTestModel(Auction, Ports, auctionTestModel)

export const named = (paths: typeof auctionModel.shortestPaths) =>
  paths().map((path) => ({ name: auctionModel.describe(path), path }))

export const Local = layerLoopLocal(Auction, Ports).pipe(
  Layer.provide(layerCreditCheckTable),
  Layer.provide(layerCurrentBidderFixed(Bidder.make("alice"))),
  Layer.provide(Layer.succeed(AutoActions, false))
)

/** The intent that makes the real actions produce each explored proposal; a rejection is a bid over every credit limit. */
export const intentFor = (step: PathStep<typeof Auction>): Intent => {
  const proposal = step.proposal
  switch (proposal._tag) {
    case "BidPlaced":
      return { _tag: "PlaceBid", amount: proposal.amount }
    case "BidRejected":
      return { _tag: "PlaceBid", amount: Amount.make(1_000_000) }
    case "Opened":
      return { _tag: "Open" }
    case "Ticked":
      return { _tag: "Tick" }
    case "Closed":
      return { _tag: "Close" }
  }
}

export const currentRepresentation = Ports.ModelPort.use((port) => Stream.runHead(port.representations)).pipe(
  Effect.map(Option.getOrThrow)
)

/** The explored `Opened` proposal carries the initial model's clock. */
export const OPENED_AT = Auction.initial.now

/** Advances the clock a second at a time until the `Tick` action, which sleeps one second, has presented. */
export const advanceUntilTicked = (now: number) =>
  Effect.gen(function*() {
    const expectedRemaining = Math.max(0, Math.ceil((OPENED_AT + AUCTION_LENGTH - now) / 1000))
    for (let attempt = 0; attempt < 5; attempt++) {
      if ((yield* currentRepresentation).remainingSeconds <= expectedRemaining) return
      yield* TestClock.adjust("1 second")
    }
  })

/** Sets the test clock to the time the explored proposal assumes. */
export const clockFor = (step: PathStep<typeof Auction>): Effect.Effect<void> =>
  Effect.gen(function*() {
    const proposal = step.proposal
    if (proposal._tag === "Opened") yield* TestClock.setTime(proposal.at)
    if (proposal._tag === "Ticked") yield* TestClock.setTime(proposal.now)
    if (proposal._tag === "BidPlaced") yield* TestClock.setTime(proposal.at)
  })

/** After a `Ticked`, advances the clock until the action that slept has presented. */
export const settleAfter = (step: PathStep<typeof Auction>) =>
  step.proposal._tag === "Ticked" ? advanceUntilTicked(step.proposal.now) : Effect.void

/** Drives the real actions with the clock set to the time each explored proposal assumes. */
export const clockedIntentDriver: Driver<
  typeof Auction,
  IntentPort<typeof Auction> | ModelPort<typeof Auction>,
  DispatchRefused
> = {
  appliesOnReturn: false,
  step: (step) =>
    clockFor(step).pipe(
      Effect.andThen(intentDriver(Ports, intentFor).step(step)),
      Effect.andThen(settleAfter(step))
    )
}
