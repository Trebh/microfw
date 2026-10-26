import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  AutoActions,
  AutoActionsGate,
  AutoEpoch,
  layerActionRunnerLocal,
  layerActionsDrain,
  layerIntentBus,
  layerLoopLocal,
  layerModelLocal,
  makePorts,
  nest,
  type ProposalOf
} from "../src/index.ts"
import { Clears } from "./fixtures/Clears.ts"
import { Counter, Ports } from "./fixtures/Counter.ts"
import { awaitFirst, captureLogs, collect, settle } from "./support.ts"

const NestedClears = nest(Counter, Clears)
const NestedClearsPorts = makePorts(NestedClears)
const NestedClearsLoop = layerLoopLocal(NestedClears, NestedClearsPorts)

const TwinClears = nest(Clears, Clears, {
  toChild: (proposal) => (proposal._tag === "ArmA" ? Option.some(proposal) : Option.none())
})
const TwinClearsPorts = makePorts(TwinClears)
const TwinClearsLoop = layerLoopLocal(TwinClears, TwinClearsPorts)

const Loop = layerLoopLocal(Counter, Ports)
const LoopWithoutAutoActions = Loop.pipe(Layer.provide(Layer.succeed(AutoActions, false)))

const DyingRunner = Layer.succeed(Ports.ActionRunner, {
  run: (intent) => (intent._tag === "Fail" ? Effect.die("boom") : Effect.succeed({ _tag: "Inc", by: 1 } as const))
})

const DyingLoop = layerActionsDrain(Counter, Ports).pipe(
  Layer.provideMerge(Layer.merge(layerModelLocal(Counter, Ports), DyingRunner)),
  Layer.provideMerge(layerIntentBus(Counter, Ports))
)

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

  it.effect("logs a defect with the intent tag and cause, and keeps draining", () => {
    const logs = captureLogs()
    return Effect.gen(function*() {
      const bus = yield* Ports.IntentBus
      const model = yield* Ports.ModelPort

      yield* bus.dispatch({ _tag: "Fail" })
      yield* settle
      yield* bus.dispatch({ _tag: "Inc", by: 1 })
      const next = yield* awaitFirst(model.representations, (r) => r.count === 1)

      assert.strictEqual(next.controlState, "low")
      assert.deepStrictEqual(logs.entries.map((entry) => [entry.level, entry.message]), [
        ["Error", ["action died", "Fail"]]
      ])
      assert.include(logs.entries[0]?.cause, "boom")
    }).pipe(Effect.provide(DyingLoop.pipe(Layer.provide(logs.layer))))
  })
})

describe("layerActionsDrain over a nested definition", () => {
  it.effect("does not hold an instant automatic child intent back behind a slow one", () =>
    Effect.gen(function*() {
      const model = yield* NestedClearsPorts.ModelPort
      const representations = yield* collect(model.representations)

      yield* model.present({ _tag: "Child", proposal: { _tag: "ArmA" } })
      yield* settle
      yield* model.present({ _tag: "Child", proposal: { _tag: "ArmB" } })
      yield* settle

      const child = representations[representations.length - 1]?.child
      assert.deepStrictEqual(child, { controlState: "busy", a: true, b: false })
    }).pipe(Effect.provide(NestedClearsLoop)))
})

describe("layerActionsDrain over a step that offers two intents", () => {
  it.effect("starts both actions in the same step", () =>
    Effect.gen(function*() {
      const model = yield* TwinClearsPorts.ModelPort
      const representations = yield* collect(model.representations)

      yield* model.present({ _tag: "ArmA" })
      yield* settle
      yield* TestClock.adjust("10 seconds")
      yield* settle

      const last = representations[representations.length - 1]
      assert.deepStrictEqual(last, {
        controlState: "idle",
        parent: { controlState: "idle", a: false, b: false },
        child: { controlState: "idle", a: false, b: false }
      })
    }).pipe(Effect.provide(TwinClearsLoop)))
})

interface Presented {
  readonly proposal: ProposalOf<typeof Counter>
  readonly epoch: Option.Option<number>
}

/** A drain over a model that records each proposal with the `AutoEpoch` it was presented under, behind a gate the test moves. */
const epochRig = (admitted: Option.Option<number>) =>
  Effect.gen(function*() {
    const admit = yield* Ref.make(admitted)
    const presented = yield* Ref.make<ReadonlyArray<Presented>>([])
    const recorder = Layer.succeed(Ports.ModelPort, {
      present: (proposal) =>
        Effect.gen(function*() {
          const epoch = yield* AutoEpoch
          yield* Ref.update(presented, (all) => [...all, { proposal, epoch }])
        }),
      representations: Stream.empty
    })
    const loop = layerActionsDrain(Counter, Ports).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          recorder,
          layerActionRunnerLocal(Counter, Ports),
          Layer.succeed(AutoActionsGate, { admit: Ref.get(admit) })
        )
      ),
      Layer.provideMerge(layerIntentBus(Counter, Ports))
    )
    const context = yield* Layer.build(loop)
    return { bus: Context.get(context, Ports.IntentBus), admit, presented: Ref.get(presented) }
  })

describe("layerActionsDrain and the epoch of an automatic action", () => {
  it.effect(
    "stamps the proposal of an automatic action with the epoch the gate admitted it under, though the gate has moved on when the action ends",
    () =>
      Effect.gen(function*() {
        const rig = yield* epochRig(Option.some(1))

        yield* rig.bus.dispatchAuto({ _tag: "AutoReset" })
        yield* settle
        yield* Ref.set(rig.admit, Option.some(2))
        yield* TestClock.adjust("1 second")
        yield* settle

        assert.deepStrictEqual(yield* rig.presented, [{ proposal: { _tag: "Reset" }, epoch: Option.some(1) }])
      })
  )

  it.effect("presents the proposal of a user intent without an epoch while the gate admits one", () =>
    Effect.gen(function*() {
      const rig = yield* epochRig(Option.some(1))

      yield* rig.bus.dispatch({ _tag: "Inc", by: 1 })
      yield* settle

      assert.deepStrictEqual(yield* rig.presented, [{ proposal: { _tag: "Inc", by: 1 }, epoch: Option.none() }])
    }))

  it.effect("drops an automatic intent while the gate admits no epoch", () =>
    Effect.gen(function*() {
      const rig = yield* epochRig(Option.none())

      yield* rig.bus.dispatchAuto({ _tag: "AutoReset" })
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle

      assert.deepStrictEqual(yield* rig.presented, [])
    }))
})