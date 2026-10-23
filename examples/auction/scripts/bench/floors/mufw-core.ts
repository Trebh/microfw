import { layerLoopLocal } from "@mufw/core"
import { Effect, Layer } from "effect"
import { Counter, CounterPorts } from "../counter.ts"

/**
 * Size floor, never run: the bench counter's local loop with no view and no platform package,
 * launched by `Effect.runFork`, which dispatches one intent.
 */
const dispatchOne = Layer.effectDiscard(
  Effect.gen(function*() {
    const intents = yield* CounterPorts.IntentPort
    yield* intents.dispatch({ _tag: "Inc", by: 1 })
  })
)

Effect.runFork(Layer.launch(dispatchOne.pipe(Layer.provide(layerLoopLocal(Counter, CounterPorts)))))
