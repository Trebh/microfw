import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Schema } from "effect"
import { expectTypeOf } from "vitest"
import { AutoActions, define, type IntentBus, layerLoopLocal, makePorts, noIntent } from "../src/index.ts"
import { awaitFirst } from "./support.ts"

class Caller extends Context.Service<Caller, string>()("test/Caller") {}

const Greeter = define({
  name: "greeter",
  model: Schema.Struct({ lastCaller: Schema.String }),
  proposal: Schema.TaggedStruct("Greeted", { caller: Schema.String }),
  intent: Schema.TaggedStruct("Greet", {}),
  representation: Schema.Struct({ controlState: Schema.Literal("idle"), lastCaller: Schema.String })
})({
  initial: { lastCaller: "nobody" },
  acceptors: { Greeted: (_, proposal) => ({ lastCaller: proposal.caller }) },
  reactors: [],
  state: (model) => ({ controlState: "idle", lastCaller: model.lastCaller }),
  nap: { idle: noIntent },
  actions: {
    Greet: () => Caller.use((caller) => Effect.succeed({ _tag: "Greeted", caller } as const))
  }
})

const Ports = makePorts<typeof Greeter, Caller>(Greeter)

const noAutoActions = Layer.succeed(AutoActions, false)

/** `Caller` is requested per call, so the layer does not require it. */
const PerRequestLoop = layerLoopLocal(Greeter, Ports).pipe(Layer.provide(noAutoActions))

const BuiltPorts = makePorts(Greeter)

const BuiltLoop = layerLoopLocal(Greeter, BuiltPorts).pipe(
  Layer.provide(Layer.succeed(Caller, "built")),
  Layer.provide(noAutoActions)
)

const lastCaller = Ports.ModelPort.use((model) =>
  awaitFirst(model.representations, (representation) => representation.lastCaller !== "nobody")
).pipe(Effect.map((representation) => representation.lastCaller))

describe("services of the dispatching fiber", () => {
  it.effect("an action runs with the services of the fiber that dispatched its intent", () =>
    Effect.gen(function*() {
      const bus = yield* Ports.IntentBus

      yield* bus.dispatch({ _tag: "Greet" }).pipe(Effect.provideService(Caller, "ann"))

      assert.strictEqual(yield* lastCaller, "ann")
    }).pipe(Effect.provide(PerRequestLoop)))

  it.effect("each dispatch runs its action with its own caller's services", () =>
    Effect.gen(function*() {
      const bus = yield* Ports.IntentBus
      const model = yield* Ports.ModelPort

      yield* bus.dispatch({ _tag: "Greet" }).pipe(Effect.provideService(Caller, "ann"))
      yield* awaitFirst(model.representations, (representation) => representation.lastCaller === "ann")
      yield* bus.dispatch({ _tag: "Greet" }).pipe(Effect.provideService(Caller, "bea"))

      const reached = yield* awaitFirst(model.representations, (representation) => representation.lastCaller === "bea")
      assert.strictEqual(reached.lastCaller, "bea")
    }).pipe(Effect.provide(PerRequestLoop)))

  it.effect("a service captured when the layer was built wins over the caller's", () =>
    Effect.gen(function*() {
      const bus = yield* Ports.IntentBus

      yield* bus.dispatch({ _tag: "Greet" }).pipe(Effect.provideService(Caller, "ann"))

      assert.strictEqual(yield* lastCaller, "built")
    }).pipe(Effect.provide(BuiltLoop)))
})

describe("per-request services in the types", () => {
  const dispatchGreet = Ports.IntentBus.use((bus) => bus.dispatch({ _tag: "Greet" }))

  it("a dispatch requires the per-request service of its ports", () => {
    expectTypeOf(dispatchGreet).toEqualTypeOf<Effect.Effect<void, never, IntentBus<typeof Greeter> | Caller>>()
  })

  it("a dispatch that provides the per-request service needs nothing else from the caller", () => {
    const answered = dispatchGreet.pipe(Effect.provideService(Caller, "ann"), Effect.provide(PerRequestLoop))

    expectTypeOf(answered).toEqualTypeOf<Effect.Effect<void, never, never>>()
  })

  it("a dispatch without the per-request service cannot be run", () => {
    const unanswered = dispatchGreet.pipe(Effect.provide(PerRequestLoop))

    // @ts-expect-error `Caller` is still required: only `Effect<_, _, never>` can be run
    const run = () => Effect.runPromise(unanswered)

    expectTypeOf(run).toBeFunction()
  })
})
