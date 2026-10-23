import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  AutoActions,
  decodeHistoryJson,
  encodeHistoryJson,
  layerLoopLocal,
  NoSuchStep,
  ReplayBaseMismatch,
  replayFrom,
  replayInto
} from "../src/index.ts"
import { Counter, Ports } from "./fixtures/Counter.ts"
import { initRecord, stepRecord, travelRecord } from "./fixtures/CounterHistory.ts"
import { collect, settle } from "./support.ts"

const inc1 = { _tag: "Inc", by: 1 } as const
const inc2 = { _tag: "Inc", by: 2 } as const
const inc4 = { _tag: "Inc", by: 4 } as const
const reset = { _tag: "Reset" } as const

const history = [initRecord(0), stepRecord(1, inc2, 2), stepRecord(2, inc1, 3), stepRecord(3, reset, 0)]

describe("history JSON", () => {
  it.effect("decodes a hand-written history", () =>
    Effect.gen(function*() {
      const json = "[{\"seq\":0,\"at\":5,\"kind\":\"init\",\"proposal\":{\"_tag\":\"None\"},\"model\":{\"count\":0}," +
        "\"representation\":{\"controlState\":\"low\",\"count\":0}}," +
        "{\"seq\":1,\"at\":9,\"kind\":\"step\",\"proposal\":{\"_tag\":\"Some\",\"value\":{\"_tag\":\"Inc\",\"by\":2}}," +
        "\"model\":{\"count\":2},\"representation\":{\"controlState\":\"low\",\"count\":2}}]"

      const decoded = yield* decodeHistoryJson(Counter)(json)

      assert.deepStrictEqual(decoded, [
        { ...initRecord(0), at: 5 },
        { ...stepRecord(1, inc2, 2), at: 9 }
      ])
    }))

  it.effect("decoding an encoded history gives back the same records", () =>
    Effect.gen(function*() {
      const json = yield* encodeHistoryJson(Counter)(history)

      const decoded = yield* decodeHistoryJson(Counter)(json)

      assert.deepStrictEqual(decoded, history)
    }))

  it.effect("keeps a travel record's travelledTo", () =>
    Effect.gen(function*() {
      const travelled = [initRecord(0), stepRecord(1, inc2, 2), travelRecord(2, 0, 0)]
      const json = yield* encodeHistoryJson(Counter)(travelled)

      const decoded = yield* decodeHistoryJson(Counter)(json)

      assert.deepStrictEqual(decoded.map((record) => record.travelledTo), [undefined, undefined, 0])
    }))

  it.effect("rejects text that is not JSON with a SchemaError", () =>
    Effect.gen(function*() {
      const error = yield* decodeHistoryJson(Counter)("[{").pipe(Effect.flip)

      assert.instanceOf(error, Schema.SchemaError)
    }))

  it.effect("rejects a record whose model does not match the definition with a SchemaError", () =>
    Effect.gen(function*() {
      const json = yield* encodeHistoryJson(Counter)(history)
      const corrupted = json.replace("\"count\":2", "\"count\":\"two\"")

      const error = yield* decodeHistoryJson(Counter)(corrupted).pipe(Effect.flip)

      assert.instanceOf(error, Schema.SchemaError)
    }))

  it.effect("rejects JSON that is not an array of records with a SchemaError", () =>
    Effect.gen(function*() {
      const error = yield* decodeHistoryJson(Counter)("{\"seq\":0}").pipe(Effect.flip)

      assert.instanceOf(error, Schema.SchemaError)
    }))
})

describe("replayFrom", () => {
  const replayed = (seq: number, records = history) =>
    replayFrom(Counter, records, seq).pipe(Result.getOrThrow)

  it("recomputes the models after seq from the model of seq", () => {
    assert.deepStrictEqual(replayed(1).map((record) => [record.seq, record.model]), [
      [2, { count: 3 }],
      [3, { count: 0 }]
    ])
  })

  it("recomputes the representation of each replayed record", () => {
    assert.deepStrictEqual(replayed(0).map((record) => record.representation), [
      { controlState: "low", count: 2 },
      { controlState: "high", count: 3 },
      { controlState: "low", count: 0 }
    ])
  })

  it("replays the recorded proposals, not the recorded models", () => {
    const tampered = [initRecord(0), stepRecord(1, inc2, 2), stepRecord(2, inc1, 99)]

    assert.deepStrictEqual(replayed(1, tampered).map((record) => record.model), [{ count: 3 }])
  })

  it("keeps the recorded proposal and time of each record", () => {
    assert.deepStrictEqual(replayed(2).map((record) => [record.at, record.kind, record.proposal]), [
      [3000, "step", Option.some(reset)]
    ])
  })

  it("replays nothing from the last record", () => {
    assert.deepStrictEqual(replayed(3), [])
  })

  it("skips a travel record inside the replayed range", () => {
    const branched = [initRecord(0), stepRecord(1, inc2, 2), travelRecord(2, 0, 0), stepRecord(3, inc1, 1)]

    assert.deepStrictEqual(replayed(0, branched).map((record) => [record.seq, record.model]), [
      [1, { count: 2 }],
      [3, { count: 3 }]
    ])
  })

  it("fails with NoSuchStep when records hold no such seq", () => {
    const result = replayFrom(Counter, history, 9)

    assert.deepStrictEqual(result, Result.fail(new NoSuchStep({ seq: 9 })))
  })
})

describe("replayInto", () => {
  const Loop = layerLoopLocal(Counter, Ports).pipe(Layer.provide(Layer.succeed(AutoActions, false)))
  const recorded = [initRecord(0), stepRecord(1, inc2, 2), stepRecord(2, inc1, 3), stepRecord(3, inc4, 7)]

  it.effect("travels to seq, then replays each later recorded proposal, in order", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const live = yield* Ports.HistoryPort
      const records = yield* collect(live.records)
      yield* model.present(inc2)
      yield* model.present(inc2)

      yield* replayInto(Ports, recorded, 1)
      yield* settle

      assert.deepStrictEqual(
        records.map((record) => [record.seq, record.kind, record.model.count, record.travelledTo]),
        [
          [0, "init", 0, undefined],
          [1, "step", 2, undefined],
          [2, "step", 4, undefined],
          [3, "travel", 2, 1],
          [4, "step", 3, undefined],
          [5, "step", 7, undefined]
        ]
      )
    }).pipe(Effect.provide(Loop)))

  it.effect("leaves the model at the replayed result", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort

      yield* replayInto(Ports, recorded, 0)

      const current = yield* Stream.runHead(model.representations)
      assert.deepStrictEqual(current, Option.some({ controlState: "high", count: 7 }))
    }).pipe(Effect.provide(Loop)))

  it.effect("fails with NoSuchStep, leaving the loop untouched, when records hold no such seq", () =>
    Effect.gen(function*() {
      const live = yield* Ports.HistoryPort
      const records = yield* collect(live.records)

      const error = yield* replayInto(Ports, recorded, 9).pipe(Effect.flip)
      yield* settle

      assert.deepStrictEqual(error, new NoSuchStep({ seq: 9 }))
      assert.deepStrictEqual(records.map((record) => record.kind), ["init"])
    }).pipe(Effect.provide(Loop)))

  it.effect("fails with NoSuchStep when the loop does not retain seq", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort

      const error = yield* replayInto(Ports, recorded, 3).pipe(Effect.flip)

      assert.deepStrictEqual(error, new NoSuchStep({ seq: 3 }))
      assert.deepStrictEqual(yield* Stream.runHead(model.representations), Option.some({ controlState: "low", count: 0 }))
    }).pipe(Effect.provide(Loop)))

  it.effect("fails with ReplayBaseMismatch, presenting nothing, when the live loop's seq differs from the recorded one", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const live = yield* Ports.HistoryPort
      const records = yield* collect(live.records)
      yield* model.present(inc2)
      yield* model.present(inc2)

      const error = yield* replayInto(Ports, recorded, 2).pipe(Effect.flip)
      yield* settle

      assert.deepStrictEqual(error, new ReplayBaseMismatch({ seq: 2 }))
      assert.deepStrictEqual(yield* Stream.runHead(model.representations), Option.some({ controlState: "high", count: 4 }))
      assert.deepStrictEqual(records.map((record) => record.kind), ["init", "step", "step", "travel"])
    }).pipe(Effect.provide(Loop)))

  it.effect("starts no automatic action when the loop runs them, so a recorded automatic proposal applies once", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const withAutomaticReset = [initRecord(0), stepRecord(1, inc4, 4), stepRecord(2, reset, 0), stepRecord(3, inc1, 1)]

      yield* replayInto(Ports, withAutomaticReset, 0)
      yield* settle
      yield* TestClock.adjust("2 seconds")

      assert.deepStrictEqual(yield* Stream.runHead(model.representations), Option.some({ controlState: "low", count: 1 }))
    }).pipe(Effect.provide(layerLoopLocal(Counter, Ports))))
})
