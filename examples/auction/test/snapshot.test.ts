import { assert, describe, it } from "@effect/vitest"
import { layerIntentBus } from "@mufw/core"
import { Effect, Layer, Option, Stream } from "effect"
import { Auction, initial } from "../src/domain/Auction.ts"
import { Amount, Bidder } from "../src/domain/Values.ts"
import { Ports } from "../src/ports.ts"
import { auctionModelLocal } from "../src/client/placements/auctionLocal.ts"

const SERVER_SNAPSHOT =
  "{\"item\":\"Vintage synth\",\"minIncrement\":5,\"highest\":{\"_tag\":\"Some\",\"value\":{\"bidder\":\"alice\",\"amount\":10,\"at\":500}},\"bids\":[{\"bidder\":\"alice\",\"amount\":10,\"at\":500}],\"endsAt\":61000,\"now\":1000,\"status\":\"open\",\"lastRejection\":{\"_tag\":\"None\"}}"

const bid = { bidder: Bidder.make("alice"), amount: Amount.make(10), at: 500 }

const seededWith = (snapshot: Option.Option<string>) =>
  auctionModelLocal(Effect.succeed(snapshot)).pipe(Layer.provideMerge(layerIntentBus(Auction, Ports)))

const seqZero = Ports.HistoryPort.use((history) => Stream.runHead(history.records)).pipe(Effect.map(Option.getOrThrow))

describe("auctionModelLocal", () => {
  it.effect("starts at seq 0 from the model the page embeds", () =>
    Effect.gen(function*() {
      const first = yield* seqZero

      assert.deepStrictEqual(
        [first.seq, first.kind, first.model.status, first.model.bids, first.representation.controlState],
        [0, "init", "open", [bid], "open"]
      )
    }).pipe(Effect.provide(seededWith(Option.some(SERVER_SNAPSHOT)))))

  it.effect("starts from the definition's initial model when the page embeds none", () =>
    Effect.gen(function*() {
      const first = yield* seqZero

      assert.deepStrictEqual(first.model, initial)
    }).pipe(Effect.provide(seededWith(Option.none()))))

  it.effect("fails with a SchemaError when the embedded text is not a model", () =>
    Effect.gen(function*() {
      const error = yield* Effect.scoped(Layer.build(seededWith(Option.some("{\"item\":1}")))).pipe(Effect.flip)

      assert.strictEqual(error._tag, "SchemaError")
    }))

  it.effect("fails with a SchemaError when the embedded element is empty", () =>
    Effect.gen(function*() {
      const error = yield* Effect.scoped(Layer.build(seededWith(Option.some("")))).pipe(Effect.flip)

      assert.strictEqual(error._tag, "SchemaError")
    }))
})
