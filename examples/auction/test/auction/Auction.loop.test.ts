import { assert, describe, it } from "@effect/vitest"
import { AutoActions, layerLoopLocal, type StepRecord } from "@mufw/core"
import { Effect, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Auction } from "../../src/auction/Auction.ts"
import { Ports } from "../../src/ports.ts"
import { layerAliceBidding } from "./Auction.fixtures.ts"

describe("opening in the loop", () => {
  const Loop = layerLoopLocal(Auction, Ports).pipe(
    Layer.provide(layerAliceBidding)
  )
  const firstRecordWhere = (predicate: (record: StepRecord<typeof Auction>) => boolean) =>
    Ports.HistoryPort.use((history) => history.records.pipe(Stream.filter(predicate), Stream.runHead)).pipe(
      Effect.map(Option.getOrThrow)
    )

  it.effect("starts the auction at the clock when the loop starts", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(7_000)

      const opened = yield* firstRecordWhere((record) => record.model.phase === "open").pipe(Effect.provide(Loop))

      assert.deepStrictEqual([opened.model.now, opened.model.endsAt], [7_000, 67_000])
    }))

  it.effect("reopens at the new clock after a reset to the initial model", () =>
    Effect.gen(function*() {
      const first = yield* firstRecordWhere((record) => record.model.phase === "open")
      yield* Ports.HistoryPort.use((history) => history.travelTo(0))
      yield* TestClock.setTime(90_000)

      yield* Ports.IntentPort.use((port) => port.dispatch({ _tag: "Open" }))
      const reopened = yield* firstRecordWhere((record) => record.seq > first.seq && record.model.phase === "open")

      assert.deepStrictEqual([reopened.model.now, reopened.model.endsAt], [90_000, 150_000])
    }).pipe(Effect.provide(Loop)))
})

describe("leaving opening by the user path", () => {
  const ManualLoop = layerLoopLocal(Auction, Ports).pipe(
    Layer.provide(layerAliceBidding),
    Layer.provide(Layer.succeed(AutoActions, false))
  )
  const latest = Ports.ModelPort.use((port) => Stream.runHead(port.representations)).pipe(Effect.map(Option.getOrThrow))
  const dispatchOpen = Ports.IntentPort.use((port) => port.dispatch({ _tag: "Open" }))
  const nextNotOpening = Ports.ModelPort.use((port) =>
    port.representations.pipe(Stream.filter((r) => r.controlState !== "opening"), Stream.runHead)
  ).pipe(Effect.map(Option.getOrThrow))

  it.effect("stays opening when automatic actions are off", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("5 seconds")

      assert.strictEqual((yield* latest).controlState, "opening")
    }).pipe(Effect.provide(ManualLoop)))

  it.effect("leaves opening when the user dispatches Open", () =>
    Effect.gen(function*() {
      yield* dispatchOpen

      assert.strictEqual((yield* nextNotOpening).controlState, "open")
    }).pipe(Effect.provide(ManualLoop)))

  it.effect("leaves opening by Open again after a travel to the initial record", () =>
    Effect.gen(function*() {
      yield* dispatchOpen
      yield* nextNotOpening
      yield* Ports.HistoryPort.use((history) => history.travelTo(0))
      const afterTravel = (yield* latest).controlState

      yield* dispatchOpen
      const afterReopen = (yield* nextNotOpening).controlState

      assert.deepStrictEqual([afterTravel, afterReopen], ["opening", "open"])
    }).pipe(Effect.provide(ManualLoop)))
})
