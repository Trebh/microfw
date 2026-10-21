import { assert, describe, it } from "@effect/vitest"
import { AutoActions, type IntentBus, layerLoopLocal, type ModelPort, type PathStep } from "@mufw/core"
import { createTestModel, type Driver, intentDriver } from "@mufw/test"
import { Effect, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Auction, type Intent } from "../src/domain/Auction.ts"
import { CreditCheck } from "../src/domain/CreditCheck.ts"
import { Ports, Rpc } from "../src/ports.ts"
import { auctionTestModel } from "./model.ts"

const model = createTestModel(Auction, Ports, auctionTestModel)

const Local = layerLoopLocal(Auction, Ports).pipe(
  Layer.provide(CreditCheck.layerLive),
  Layer.provide(Layer.succeed(AutoActions, false))
)

const Remote = Layer.merge(Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(
  Layer.provide(Rpc.layerClientTest),
  Layer.provide(Rpc.layerHandlers),
  Layer.provide(Local)
)

const named = (paths: typeof model.shortestPaths) => paths().map((path) => ({ name: model.describe(path), path }))

describe("local placement", () => {
  it.effect.each(named(model.shortestPaths))("shortest: $name", ({ path }) => model.run(path).pipe(Effect.provide(Local)))
  it.effect.each(named(model.simplePaths))("simple: $name", ({ path }) => model.run(path).pipe(Effect.provide(Local)))
})

describe("remote placement (in-process RPC)", () => {
  it.effect.each(named(model.shortestPaths))("shortest: $name", ({ path }) => model.run(path).pipe(Effect.provide(Remote)))
  it.effect.each(named(model.simplePaths))("simple: $name", ({ path }) => model.run(path).pipe(Effect.provide(Remote)))
})

const intentFor = (step: PathStep<typeof Auction>): Intent => {
  const proposal = step.proposal
  if (proposal._tag === "Bid") return { _tag: "PlaceBid", bidder: proposal.bidder, amount: proposal.amount }
  if (proposal._tag === "BidRejected") return { _tag: "PlaceBid", bidder: "alice", amount: 1_000_000 }
  return { _tag: proposal._tag }
}

const currentRepresentation = Ports.ModelPort.use((port) => Stream.runHead(port.representations)).pipe(
  Effect.map(Option.getOrThrow)
)

/** Advances the clock a second at a time until the `Tick` action, which sleeps one second, has presented. */
const advanceUntilTicked = (now: number) =>
  Effect.gen(function*() {
    const expectedRemaining = Math.max(0, Math.ceil((Auction.initial.endsAt - now) / 1000))
    for (let attempt = 0; attempt < 5; attempt++) {
      if ((yield* currentRepresentation).remainingSeconds <= expectedRemaining) return
      yield* TestClock.adjust("1 second")
    }
  })

/** Drives the real actions with the clock set to the time each explored proposal assumes. */
const clockedIntentDriver: Driver<typeof Auction, IntentBus<typeof Auction> | ModelPort<typeof Auction>> = {
  appliesOnReturn: false,
  step: (step) =>
    Effect.gen(function*() {
      const proposal = step.proposal
      if (proposal._tag === "Tick") yield* TestClock.setTime(proposal.now)
      if (proposal._tag === "Bid") yield* TestClock.setTime(proposal.at)
      yield* intentDriver(Ports, intentFor).step(step)
      if (proposal._tag === "Tick") yield* advanceUntilTicked(proposal.now)
    })
}

describe("intent driver", () => {
  it.effect("reaches sold through the real actions", () =>
    Effect.gen(function*() {
      const toSold = model.shortestPaths().find((path) => path.target === "sold")!

      yield* model.run(toSold, clockedIntentDriver)

      assert.strictEqual((yield* currentRepresentation).controlState, "sold")
    }).pipe(Effect.provide(Local)))
})
