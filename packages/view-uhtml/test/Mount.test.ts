import { assert, describe, it } from "@effect/vitest"
import { layerLoopLocal } from "@mufw/core"
import { Effect, Layer, Stream } from "effect"
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
  const layer = layerMount(Ports, { root, view, render }).pipe(Layer.provideMerge(layerLoopLocal(Counter, Ports)))
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
