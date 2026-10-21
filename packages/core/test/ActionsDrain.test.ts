import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { AutoActions, layerLoopLocal } from "../src/index.ts"
import { Counter, Ports } from "./fixtures/Counter.ts"
import { awaitFirst, collect, settle } from "./support.ts"

const Loop = layerLoopLocal(Counter, Ports)
const LoopWithoutAutoActions = Loop.pipe(Layer.provide(Layer.succeed(AutoActions, false)))

const proposalTags = (records: ReadonlyArray<{ readonly proposal: Option.Option<{ readonly _tag: string }> }>) =>
  records.map((record) => Option.match(record.proposal, { onNone: () => "-", onSome: (p) => p._tag }))

describe("layerActionsDrain", () => {
  it.effect("skips an automatic intent whose tag is already in flight", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const records = yield* collect((yield* Ports.HistoryPort).records)

      yield* model.present({ _tag: "Inc", by: 3 })
      yield* settle
      yield* model.present({ _tag: "Inc", by: 1 })
      yield* settle
      yield* TestClock.adjust("10 seconds")

      assert.deepStrictEqual(proposalTags(records), ["-", "Inc", "Inc", "Reset"])
    }).pipe(Effect.provide(Loop)))

  it.effect("leaves the model untouched when an action fails, and keeps draining", () =>
    Effect.gen(function*() {
      const bus = yield* Ports.IntentBus
      const model = yield* Ports.ModelPort
      const records = yield* collect((yield* Ports.HistoryPort).records)

      yield* bus.dispatch({ _tag: "Fail" })
      yield* settle
      const afterFailure = proposalTags(records)
      yield* bus.dispatch({ _tag: "Inc", by: 1 })
      const next = yield* awaitFirst(model.representations, (r) => r.count === 1)

      assert.deepStrictEqual(afterFailure, ["-"])
      assert.strictEqual(next.controlState, "low")
    }).pipe(Effect.provide(Loop)))

  it.effect("drops automatic intents when AutoActions is false, but still runs user intents", () =>
    Effect.gen(function*() {
      const bus = yield* Ports.IntentBus
      const model = yield* Ports.ModelPort
      const records = yield* collect((yield* Ports.HistoryPort).records)

      yield* model.present({ _tag: "Inc", by: 3 })
      yield* TestClock.adjust("10 seconds")
      const afterAuto = proposalTags(records)
      yield* bus.dispatch({ _tag: "Inc", by: 1 })
      const next = yield* awaitFirst(model.representations, (r) => r.count === 4)

      assert.deepStrictEqual(afterAuto, ["-", "Inc"])
      assert.strictEqual(next.controlState, "high")
    }).pipe(Effect.provide(LoopWithoutAutoActions)))
})
