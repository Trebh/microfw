import { assert, describe, it } from "@effect/vitest"
import { DispatchRefused, layerLoopLocal } from "@mufw/core"
import { Context, Deferred, Effect, Exit, Layer, Scope, Stream } from "effect"
import { Document } from "uhtml/dom"
import init from "uhtml/init"
import { Counter, Ports } from "../../core/test/fixtures/Counter.ts"
import { layerMount, type View } from "../src/index.ts"

interface DomNode {
  readonly localName?: string
  readonly childNodes?: ArrayLike<DomNode>
  dispatchEvent(event: Event): boolean
}

const findElement = (node: DomNode, localName: string): DomNode | undefined => {
  if (node.localName === localName) return node
  return Array.from(node.childNodes ?? []).map((child) => findElement(child, localName)).find(Boolean)
}

const document = new Document()
const { render, html } = init(document as unknown as globalThis.Document)

type CounterView = View<typeof Counter.representation.Type, typeof Counter.intent.Type>
const view: CounterView = (representation, dispatch) =>
  html`<p>count: ${representation.count}</p>
    <button onclick=${() => dispatch({ _tag: "Inc", by: 1 })}>+</button>`

const mounted = () => {
  const root = document.createElement("div") as unknown as Element
  const layer = layerMount(Ports, { root, view, render, onRefused: () => Effect.void }).pipe(
    Layer.provideMerge(layerLoopLocal(Counter, Ports))
  )
  return { root, layer }
}

const countReached = (count: number) =>
  Effect.gen(function*() {
    const model = yield* Ports.ModelPort
    yield* model.representations.pipe(Stream.filter((r) => r.count === count), Stream.runHead)
    yield* Effect.yieldNow
  })

describe("layerMount", () => {
  it.effect("renders every representation into the root", () => {
    const { root, layer } = mounted()
    return Effect.gen(function*() {
      const model = yield* Ports.ModelPort

      yield* model.present({ _tag: "Inc", by: 1 })
      yield* countReached(1)

      assert.include(root.textContent, "count: 1")
    }).pipe(Effect.provide(layer))
  })

  it.effect("dispatches the intent bound to a DOM event", () => {
    const { root, layer } = mounted()
    return Effect.gen(function*() {
      const model = yield* Ports.ModelPort
      yield* model.present({ _tag: "Inc", by: 1 })
      yield* countReached(1)

      findElement(root as unknown as DomNode, "button")!.dispatchEvent(new Event("click"))
      yield* countReached(2)

      assert.include(root.textContent, "count: 2")
    }).pipe(Effect.provide(layer))
  })
})

const Marker = Context.Reference<string>("test/Marker", { defaultValue: () => "default" })

/** A loop whose intent port is `dispatch`, so a test observes the fiber the DOM event started. */
const mountedWithDispatch = (
  dispatch: () => Effect.Effect<void, DispatchRefused>,
  onRefused: (refused: DispatchRefused) => Effect.Effect<void> = () => Effect.void
) => {
  const root = document.createElement("div") as unknown as Element
  const deps = Layer.mergeAll(
    Layer.succeed(Ports.ModelPort, {
      present: () => Effect.void,
      representations: Stream.make({ controlState: "low" as const, count: 0 })
    }),
    Layer.succeed(Ports.IntentPort, { dispatch }),
    Layer.succeed(Marker, "from-layer")
  )
  const layer = layerMount(Ports, { root, view, render, onRefused }).pipe(Layer.provideMerge(deps))
  return { root, layer }
}

describe("layerMount fibers started by the DOM", () => {
  it.effect("see the services provided to the layer", () => {
    const received = Deferred.makeUnsafe<string>()
    const { root, layer } = mountedWithDispatch(() =>
      Effect.gen(function*() {
        yield* Deferred.succeed(received, yield* Marker)
      })
    )
    return Effect.gen(function*() {
      yield* countReached(0)

      findElement(root as unknown as DomNode, "button")!.dispatchEvent(new Event("click"))

      assert.strictEqual(yield* Deferred.await(received), "from-layer")
    }).pipe(Effect.provide(layer))
  })

  it.effect("are interrupted when the layer scope closes", () => {
    const started = Deferred.makeUnsafe<void>()
    const interrupted = Deferred.makeUnsafe<void>()
    const { root, layer } = mountedWithDispatch(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        Effect.asVoid
      )
    )
    return Effect.gen(function*() {
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(layer, scope)
      yield* countReached(0).pipe(Effect.provideContext(context))
      findElement(root as unknown as DomNode, "button")!.dispatchEvent(new Event("click"))
      yield* Deferred.await(started)

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted)
    })
  })
})

describe("layerMount refusals", () => {
  it.effect("reports a dispatch the port refused to onRefused", () => {
    const reported = Deferred.makeUnsafe<DispatchRefused>()
    const { root, layer } = mountedWithDispatch(
      () => Effect.fail(new DispatchRefused({ intentTag: "Inc", message: "No session" })),
      (refused) => Deferred.succeed(reported, refused).pipe(Effect.asVoid)
    )
    return Effect.gen(function*() {
      yield* countReached(0)

      findElement(root as unknown as DomNode, "button")!.dispatchEvent(new Event("click"))

      const refused = yield* Deferred.await(reported)
      assert.deepStrictEqual([refused._tag, refused.intentTag, refused.message], ["DispatchRefused", "Inc", "No session"])
    }).pipe(Effect.provide(layer))
  })
})
