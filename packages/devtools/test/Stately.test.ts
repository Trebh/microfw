import { assert, describe, it } from "@effect/vitest"
import { exploreGraph, layerLoopLocal, toXStateDefinition } from "@mufw/core"
import { createInspector, type StatelyInspectionEvent } from "@statelyai/inspect"
import { Effect, Layer, Stream } from "effect"
import { Counter, Ports } from "../../core/test/fixtures/Counter.ts"
import { exploreNested, NestedCounter, NestedPorts } from "../../core/test/fixtures/NestedCounter.ts"
import { layerStately, replayOnStart, type StartableInspector } from "../src/index.ts"

const definition = toXStateDefinition(
  Counter,
  exploreGraph(Counter, () => [{ _tag: "Inc", by: 1 }, { _tag: "Inc", by: 3 }, { _tag: "Reset" }])
)

describe("layerStately", () => {
  it.effect("registers the actor with the explored diagram, then sends each step as event and snapshot", () => {
    const sent: Array<StatelyInspectionEvent> = []
    const inspector = createInspector({ send: (event) => void sent.push(event) })
    const layer = layerStately(Counter, Ports, inspector, { definition }).pipe(
      Layer.provideMerge(layerLoopLocal(Counter, Ports))
    )
    return Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort

      yield* model.present({ _tag: "Inc", by: 1 })
      yield* history.records.pipe(Stream.take(2), Stream.runDrain)
      yield* Effect.yieldNow

      const [actor, event, snapshot] = sent
      assert.deepStrictEqual(sent.map((e) => e.type), ["@xstate.actor", "@xstate.event", "@xstate.snapshot"])
      assert.deepStrictEqual(actor?.type === "@xstate.actor" && JSON.parse(actor.definition!), {
        id: "counter",
        initial: "low",
        states: {
          low: { on: { Inc: [{ target: "low" }, { target: "high" }], Reset: "low" } },
          high: { on: { Inc: "high", Reset: "low" } }
        }
      })
      assert.deepStrictEqual(event?.type === "@xstate.event" && event.event, { _tag: "Inc", by: 1, type: "Inc" })
      const inspected: unknown = snapshot?.type === "@xstate.snapshot" && snapshot.snapshot
      assert.deepStrictEqual(inspected, {
        status: "active",
        context: { count: 1 },
        value: "low"
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("sends a nested child step with the diagram's event name", () => {
    const sent: Array<StatelyInspectionEvent> = []
    const inspector = createInspector({ send: (event) => void sent.push(event) })
    const nestedDefinition = toXStateDefinition(NestedCounter, exploreGraph(NestedCounter, exploreNested))
    const layer = layerStately(NestedCounter, NestedPorts, inspector, { definition: nestedDefinition }).pipe(
      Layer.provideMerge(layerLoopLocal(NestedCounter, NestedPorts))
    )
    return Effect.gen(function*() {
      const model = yield* NestedPorts.ModelPort
      const history = yield* NestedPorts.HistoryPort

      yield* model.present({ _tag: "Child", proposal: { _tag: "Inc", by: 1 } })
      yield* history.records.pipe(Stream.take(2), Stream.runDrain)
      yield* Effect.yieldNow

      const event = sent.find((e) => e.type === "@xstate.event")
      assert.strictEqual(event?.type === "@xstate.event" && event.event.type, "Child/Inc")
    }).pipe(Effect.provide(layer))
  })
})

const recordingInspector = (calls: Array<string>): StartableInspector => ({
  actor: (actor, snapshot) => void calls.push(`actor ${actor.sessionId} ${JSON.stringify(snapshot)}`),
  event: (actor, event) => void calls.push(`event ${actor} ${event.type}`),
  snapshot: (actor, snapshot) => void calls.push(`snapshot ${actor} ${JSON.stringify(snapshot)}`),
  start: () => void calls.push("start")
})

describe("replayOnStart", () => {
  it.effect("re-sends the actor registration and only the latest snapshot after starting", () => {
    const calls: Array<string> = []
    const inspector = replayOnStart(recordingInspector(calls))
    const layer = layerStately(Counter, Ports, inspector, { definition }).pipe(
      Layer.provideMerge(layerLoopLocal(Counter, Ports))
    )
    return Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      const history = yield* Ports.HistoryPort
      yield* model.present({ _tag: "Inc", by: 1 })
      yield* model.present({ _tag: "Inc", by: 1 })
      yield* history.records.pipe(Stream.take(3), Stream.runDrain)
      yield* Effect.yieldNow
      calls.length = 0

      inspector.start()

      assert.deepStrictEqual(calls, [
        "start",
        `actor counter {"context":{"count":0},"value":"low"}`,
        `snapshot counter {"context":{"count":2},"value":"low"}`
      ])
    }).pipe(Effect.provide(layer))
  })

  it("only starts when nothing was sent yet", () => {
    const calls: Array<string> = []

    replayOnStart(recordingInspector(calls)).start()

    assert.deepStrictEqual(calls, ["start"])
  })
})
