import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { footprint } from "../src/Footprint.ts"
import {
  AutoActions,
  define,
  HistoryLimit,
  HistoryRetainedSize,
  layerLoopLocal,
  makePorts,
  NoSuchStep
} from "../src/index.ts"
import { Counter, Ports as CounterPorts } from "./fixtures/Counter.ts"
import { collect } from "./support.ts"

/** Every `Add` copies the entries; `Noop` leaves the model as it is. */
const Ledger = define({
  name: "ledger",
  model: Schema.Struct({ entries: Schema.Array(Schema.Int) }),
  proposal: Schema.Union([Schema.TaggedStruct("Add", { value: Schema.Int }), Schema.TaggedStruct("Noop", {})]),
  intent: Schema.TaggedStruct("Add", { value: Schema.Int }),
  representation: Schema.Struct({ controlState: Schema.Literals(["open"]), size: Schema.Int })
})({
  controlStates: ["open"],
  initial: { entries: [] },
  acceptors: [(model, proposal) => (proposal._tag === "Add" ? { entries: [...model.entries, proposal.value] } : model)],
  reactors: [],
  state: (model) => ({ controlState: "open", size: model.entries.length }),
  nap: () => Option.none(),
  actions: { Add: (intent) => Effect.succeed({ _tag: "Add", value: intent.value }) }
})
const Ports = makePorts(Ledger)

const add = (value: number) => ({ _tag: "Add", value }) as const
const noop = { _tag: "Noop" } as const

/** Without automatic actions and with the given bounds. */
const loopWith = (bounds: { readonly size: number; readonly limit?: number }, initial?: typeof Ledger.initial) =>
  layerLoopLocal(Ledger, Ports, initial === undefined ? undefined : { initial }).pipe(
    Layer.provide(Layer.succeed(HistoryRetainedSize, bounds.size)),
    Layer.provide(Layer.succeed(HistoryLimit, bounds.limit ?? 1000)),
    Layer.provide(Layer.succeed(AutoActions, false))
  )

const presentAll = (values: ReadonlyArray<number>) =>
  Effect.gen(function*() {
    const model = yield* Ports.ModelPort
    yield* Effect.forEach(values, (value) => model.present(add(value)), { discard: true })
  })

const retainedSeqs = Effect.gen(function*() {
  const history = yield* Ports.HistoryPort
  const records = yield* collect(history.records)
  return records.map((record) => record.seq)
})

// A record of the Ledger after its kth `Add` costs 72 + 8k bytes: the model object (16 + 8) and its
// copied entries (16 + 8k), the representation object (16 + 2 * 8); the numbers and the unchanged
// "open" cost no more than the slots that hold them.
describe("history retention by size", () => {
  it.effect("a model that grows past the size bound evicts the oldest records while the count is under the limit", () =>
    Effect.gen(function*() {
      yield* presentAll([1, 2, 3, 4, 5, 6])

      const seqs = yield* retainedSeqs

      assert.deepStrictEqual(seqs, [0, 3, 4, 5, 6])
    }).pipe(Effect.provide(loopWith({ size: 450 }))))

  it.effect("travelTo a record evicted for its size fails with NoSuchStep", () =>
    Effect.gen(function*() {
      yield* presentAll([1, 2, 3, 4, 5, 6])
      const history = yield* Ports.HistoryPort

      const exit = yield* Effect.exit(history.travelTo(2))

      assert.deepStrictEqual(exit, Exit.fail(new NoSuchStep({ seq: 2 })))
    }).pipe(Effect.provide(loopWith({ size: 450 }))))

  it.effect("travelTo the oldest record the size bound kept still works", () =>
    Effect.gen(function*() {
      yield* presentAll([1, 2, 3, 4, 5, 6])
      const history = yield* Ports.HistoryPort
      const model = yield* Ports.ModelPort

      yield* history.travelTo(3)

      const current = yield* Stream.runHead(model.representations)
      assert.deepStrictEqual(current, Option.some({ controlState: "open", size: 3 }))
    }).pipe(Effect.provide(loopWith({ size: 450 }))))

  it.effect("keeps the initial record and the newest one when a single record exceeds the bound", () =>
    Effect.gen(function*() {
      yield* presentAll([1, 2, 3])

      const seqs = yield* retainedSeqs

      assert.deepStrictEqual(seqs, [0, 3])
    }).pipe(Effect.provide(loopWith({ size: 10 }))))

  it.effect("an initial model larger than the bound does not count against it", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      yield* model.present(noop)
      yield* model.present(noop)

      const seqs = yield* retainedSeqs

      assert.deepStrictEqual(seqs, [0, 1, 2])
    }).pipe(Effect.provide(loopWith({ size: 100 }, { entries: Array.from({ length: 1000 }, () => 0) }))))

  it.effect("a step that leaves the model unchanged costs only its representation", () =>
    Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      yield* Effect.forEach(Array.from({ length: 10 }), () => model.present(noop), { discard: true })

      const seqs = yield* retainedSeqs

      assert.deepStrictEqual(seqs, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    }).pipe(Effect.provide(loopWith({ size: 450 }, { entries: Array.from({ length: 100 }, () => 0) }))))

  it.effect("a model that does not grow is bounded by the count alone", () =>
    Effect.gen(function*() {
      const model = yield* CounterPorts.ModelPort
      const inc = { _tag: "Inc", by: 1 } as const
      yield* Effect.forEach([inc, inc, inc, inc, inc], (proposal) => model.present(proposal), { discard: true })
      const history = yield* CounterPorts.HistoryPort

      const records = yield* collect(history.records)

      assert.deepStrictEqual(records.map((record) => record.seq), [0, 4, 5])
    }).pipe(
      Effect.provide(
        layerLoopLocal(Counter, CounterPorts).pipe(
          Layer.provide(Layer.succeed(HistoryRetainedSize, 1000)),
          Layer.provide(Layer.succeed(HistoryLimit, 3)),
          Layer.provide(Layer.succeed(AutoActions, false))
        )
      )
    ))
})

describe("footprint", () => {
  it("is 0 for a node the previous model shares", () => {
    const shared = { name: "abc", tags: [1, 2] }

    assert.strictEqual(footprint(shared, shared), 0)
  })

  it("counts a copied array by its slots and a new element by its own size", () => {
    const first = { a: 1 }
    const second = { a: 2 }

    // Array 16 + 3 * 8, the new element 16 + 8; the two shared elements cost nothing.
    assert.strictEqual(footprint([first, second, { a: 3 }], [first, second]), 64)
  })

  it("counts an object by its keys and a changed string by its length", () => {
    // 16 + 2 * 8 for the object and 4 for the new string; the number costs its slot.
    assert.strictEqual(footprint({ name: "wxyz", n: 2 }, { name: "abcd", n: 1 }), 36)
  })

  it("counts an equal string as shared", () => {
    assert.strictEqual(footprint({ name: "abcd", n: 2 }, { name: "abcd", n: 1 }), 32)
  })

  it("counts a Map by its entries without walking it", () => {
    assert.strictEqual(footprint(new Map([[1, "a"], [2, "b"], [3, "c"]]), undefined), 64)
  })
})
