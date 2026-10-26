import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { AutoActions, compose, layerLoopLocal, makePorts, proposalLabel } from "../src/index.ts"
import { Counter } from "./fixtures/Counter.ts"
import { CounterRows, RowsPorts } from "./fixtures/CounterRows.ts"
import { Roster } from "./fixtures/Roster.ts"
import { collect, settle } from "./support.ts"

const Broadcast = compose(Roster, (part) => ({
  Rows: part.collection(Counter, {
    keys: (roster) => roster.ids,
    fromParent: (proposal) => proposal._tag === "Added" ? Option.some({ _tag: "Inc", by: 1 } as const) : Option.none()
  })
}))
const BroadcastPorts = makePorts(Broadcast)
const BroadcastLoop = layerLoopLocal(Broadcast, BroadcastPorts).pipe(Layer.provide(Layer.succeed(AutoActions, false)))

const RowsLoop = layerLoopLocal(CounterRows, RowsPorts)

const labels = (records: ReadonlyArray<{ readonly proposal: Option.Option<{ readonly _tag: string }> }>) =>
  records.map((record) => Option.match(record.proposal, { onNone: () => "-", onSome: (p) => proposalLabel(CounterRows, p) }))

describe("compose over the local loop", () => {
  it.effect("a parent proposal forwarded to two instances is one history record with both changed", () =>
    Effect.gen(function*() {
      const model = yield* BroadcastPorts.ModelPort
      const records = yield* collect((yield* BroadcastPorts.HistoryPort).records)
      yield* model.present({ _tag: "Added", id: "a" })
      yield* model.present({ _tag: "Added", id: "b" })
      yield* settle
      const before = records.length

      yield* model.present({ _tag: "Added", id: "a" })
      yield* settle

      const added = records.slice(before)
      assert.deepStrictEqual(added.map((record) => record.proposal), [Option.some({ _tag: "Added", id: "a" } as const)])
      assert.deepStrictEqual(added[0]?.model, {
        parent: { ids: ["a", "b"] },
        parts: { Rows: [{ key: "a", model: { count: 2 } }, { key: "b", model: { count: 1 } }] }
      })
    }).pipe(Effect.provide(BroadcastLoop)))
})

describe("compose automatic actions", () => {
  it.effect("runs the automatic actions of two instances concurrently", () =>
    Effect.gen(function*() {
      const model = yield* RowsPorts.ModelPort
      const records = yield* collect((yield* RowsPorts.HistoryPort).records)
      yield* model.present({ _tag: "Added", id: "a" })
      yield* model.present({ _tag: "Added", id: "b" })

      yield* model.present({ _tag: "Rows", key: "a", proposal: { _tag: "Inc", by: 3 } })
      yield* model.present({ _tag: "Rows", key: "b", proposal: { _tag: "Inc", by: 3 } })
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle

      const resets = labels(records).filter((label) => label.endsWith("/Reset")).sort()
      assert.deepStrictEqual(resets, ["Rows[a]/Reset", "Rows[b]/Reset"])
    }).pipe(Effect.provide(RowsLoop)))

  it.effect("skips an instance's automatic intent while the same instance's is in flight", () =>
    Effect.gen(function*() {
      const model = yield* RowsPorts.ModelPort
      const records = yield* collect((yield* RowsPorts.HistoryPort).records)
      yield* model.present({ _tag: "Added", id: "a" })

      yield* model.present({ _tag: "Rows", key: "a", proposal: { _tag: "Inc", by: 3 } })
      yield* settle
      yield* model.present({ _tag: "Rows", key: "a", proposal: { _tag: "Inc", by: 1 } })
      yield* settle
      yield* TestClock.adjust("10 seconds")
      yield* settle

      assert.deepStrictEqual(labels(records), ["-", "Added", "Rows[a]/Inc", "Rows[a]/Inc", "Rows[a]/Reset"])
    }).pipe(Effect.provide(RowsLoop)))
})
