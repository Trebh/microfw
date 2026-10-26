import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Stream } from "effect"
import { AutoActions, define, DispatchRefused, type Forward, layerForward, layerLoopLocal, makePorts } from "../src/index.ts"
import {
  Counter,
  counterAcceptors,
  counterNap,
  Intent,
  Model,
  Ports,
  Proposal,
  Representation
} from "./fixtures/Counter.ts"
import { awaitFirst, captureLogs, collect, settle } from "./support.ts"

/** The Counter's behaviour under another name, so both loops can live in one context. */
const Tally = define({
  name: "tally",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  initial: Counter.initial,
  acceptors: counterAcceptors,
  reactors: Counter.reactors,
  state: Counter.state,
  nap: counterNap,
  actions: Counter.actions
})
const TallyPorts = makePorts(Tally)

const WithoutAutoActions = Layer.succeed(AutoActions, false)
const Loops = Layer.merge(layerLoopLocal(Counter, Ports), layerLoopLocal(Tally, TallyPorts)).pipe(
  Layer.provide(WithoutAutoActions)
)

const island = (forward: Forward<typeof Counter, typeof Tally>) =>
  layerForward(Ports, TallyPorts, forward).pipe(Layer.provideMerge(Loops))

const inc = (by: number) => ({ _tag: "Inc", by }) as const

const explode = (message: string): never => {
  throw new Error(message)
}

describe("layerForward", () => {
  it.effect("dispatches the mapped intent into the other definition", () =>
    Effect.gen(function*() {
      const source = yield* Ports.ModelPort
      const target = yield* TallyPorts.ModelPort
      yield* settle

      yield* source.present(inc(3))
      const forwarded = yield* awaitFirst(target.representations, (representation) => representation.count === 10)

      assert.deepStrictEqual(forwarded, { controlState: "high", count: 10 })
    }).pipe(Effect.provide(
      island((_previous, current) => current.controlState === "high" ? Option.some(inc(10)) : Option.none())
    )))

  it.effect("dispatches nothing when the mapping is none", () =>
    Effect.gen(function*() {
      const source = yield* Ports.ModelPort
      const records = yield* collect((yield* TallyPorts.HistoryPort).records)
      yield* settle

      yield* source.present(inc(1))
      yield* source.present(inc(1))
      yield* settle

      assert.deepStrictEqual(records.map((record) => record.proposal), [Option.none()])
    }).pipe(Effect.provide(island(() => Option.none()))))

  it.effect("passes the previous representation, none for the first", () =>
    Effect.gen(function*() {
      const source = yield* Ports.ModelPort
      const target = yield* TallyPorts.ModelPort
      yield* settle

      yield* source.present(inc(3))
      yield* settle

      const current = yield* Stream.runHead(target.representations)
      assert.deepStrictEqual(current, Option.some({ controlState: "high", count: 5 }))
    }).pipe(Effect.provide(
      layerForward(Ports, TallyPorts, (previous, current) =>
        Option.some(inc(current.count - Option.match(previous, { onNone: () => 0, onSome: (p) => p.count })))).pipe(
          Layer.provideMerge(Layer.merge(
            layerLoopLocal(Counter, Ports, { initial: { count: 2 } }),
            layerLoopLocal(Tally, TallyPorts)
          )),
          Layer.provide(WithoutAutoActions)
        )
    )))

  it.effect("logs a refused dispatch at warning level and keeps forwarding", () => {
    const logs = captureLogs()
    const received: Array<unknown> = []
    const Refusing = Layer.succeed(TallyPorts.IntentPort, {
      dispatch: (intent) =>
        intent._tag === "Reset"
          ? Effect.fail(new DispatchRefused({ intentTag: "Reset", message: "not today" }))
          : Effect.sync(() => void received.push(intent))
    })
    const forward: Forward<typeof Counter, typeof Tally> = (_previous, current) =>
      Option.some(current.count === 1 ? { _tag: "Reset" } : inc(current.count))
    const Island = layerForward(Ports, TallyPorts, forward).pipe(
      Layer.provideMerge(Layer.merge(layerLoopLocal(Counter, Ports), Refusing)),
      Layer.provide(WithoutAutoActions),
      Layer.provide(logs.layer)
    )
    return Effect.gen(function*() {
      const source = yield* Ports.ModelPort
      yield* settle

      yield* source.present(inc(1))
      yield* settle
      yield* source.present(inc(1))
      yield* settle

      assert.deepStrictEqual(received, [inc(0), inc(2)])
      assert.deepStrictEqual(logs.entries.map((entry) => [entry.level, entry.message]), [
        ["Warn", ["forwarded intent refused", "Reset", "not today"]]
      ])
    }).pipe(Effect.provide(Island))
  })

  it.effect("logs a dispatch defect at error level and keeps forwarding", () => {
    const logs = captureLogs()
    const received: Array<unknown> = []
    const Dying = Layer.succeed(TallyPorts.IntentPort, {
      dispatch: (intent) =>
        intent._tag === "Reset"
          ? Effect.die(new Error("lost transport"))
          : Effect.sync(() => void received.push(intent))
    })
    const forward: Forward<typeof Counter, typeof Tally> = (_previous, current) =>
      Option.some(current.count === 1 ? { _tag: "Reset" } : inc(current.count))
    const Island = layerForward(Ports, TallyPorts, forward).pipe(
      Layer.provideMerge(Layer.merge(layerLoopLocal(Counter, Ports), Dying)),
      Layer.provide(WithoutAutoActions),
      Layer.provide(logs.layer)
    )
    return Effect.gen(function*() {
      const source = yield* Ports.ModelPort
      yield* settle

      yield* source.present(inc(1))
      yield* settle
      yield* source.present(inc(1))
      yield* settle

      assert.deepStrictEqual(received, [inc(0), inc(2)])
      assert.deepStrictEqual(logs.entries.map((entry) => [entry.level, entry.message]), [
        ["Error", ["forwarded intent died", "Reset"]]
      ])
      assert.include(logs.entries[0]?.cause, "lost transport")
    }).pipe(Effect.provide(Island))
  })

  it.effect("logs a throw from forward at error level and keeps forwarding", () => {
    const logs = captureLogs()
    const received: Array<unknown> = []
    const Recording = Layer.succeed(TallyPorts.IntentPort, {
      dispatch: (intent) => Effect.sync(() => void received.push(intent))
    })
    const forward: Forward<typeof Counter, typeof Tally> = (_previous, current) =>
      current.count === 1 ? explode("bad mapping") : Option.some(inc(current.count))
    const Island = layerForward(Ports, TallyPorts, forward).pipe(
      Layer.provideMerge(Layer.merge(layerLoopLocal(Counter, Ports), Recording)),
      Layer.provide(WithoutAutoActions),
      Layer.provide(logs.layer)
    )
    return Effect.gen(function*() {
      const source = yield* Ports.ModelPort
      yield* settle

      yield* source.present(inc(1))
      yield* settle
      yield* source.present(inc(1))
      yield* settle

      assert.deepStrictEqual(received, [inc(0), inc(2)])
      assert.deepStrictEqual(logs.entries.map((entry) => [entry.level, entry.message]), [
        ["Error", ["forward died"]]
      ])
      assert.include(logs.entries[0]?.cause, "bad mapping")
    }).pipe(Effect.provide(Island))
  })
})
