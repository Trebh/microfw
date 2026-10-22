import { assert, describe, it } from "@effect/vitest"
import { AutoActions, layerLoopLocal } from "@mufw/core"
import { Effect, Layer } from "effect"
import { Document } from "uhtml/dom"
import init from "uhtml/init"
import { NestedCounter, NestedPorts } from "../../core/test/fixtures/NestedCounter.ts"
import { layerPanel } from "../src/index.ts"

interface DomNode {
  readonly localName?: string
  readonly textContent?: string | null
  readonly childNodes?: ArrayLike<DomNode>
}

const findElements = (node: DomNode, localName: string): Array<DomNode> => {
  const own = node.localName === localName ? [node] : []
  return own.concat(Array.from(node.childNodes ?? []).flatMap((child) => findElements(child, localName)))
}

const document = new Document()
const { render, html } = init(document as unknown as globalThis.Document)

const rowsRendered = (root: Element, rows: number): Effect.Effect<void> =>
  Effect.suspend(() =>
    findElements(root as unknown as DomNode, "li").length < rows
      ? Effect.yieldNow.pipe(Effect.andThen(rowsRendered(root, rows)))
      : Effect.void
  )

describe("layerPanel over a nested definition", () => {
  it.effect("lists one history holding both the parent's and the child's proposals", () => {
    const root = document.createElement("div") as unknown as Element
    const Loop = layerLoopLocal(NestedCounter, NestedPorts).pipe(Layer.provide(Layer.succeed(AutoActions, false)))
    const layer = layerPanel(NestedCounter, NestedPorts, { root, render, html }).pipe(Layer.provideMerge(Loop))
    return Effect.gen(function*() {
      const model = yield* NestedPorts.ModelPort

      yield* model.present({ _tag: "Inc", by: 1 })
      yield* model.present({ _tag: "Child", proposal: { _tag: "Inc", by: 3 } })
      yield* rowsRendered(root, 3)

      const rows = findElements(root as unknown as DomNode, "li").map((row) => (row.textContent ?? "").trim())
      assert.deepStrictEqual(rows, [
        "#0 init  → low/low",
        "#1 step Inc → low/low",
        "#2 step Child/Inc → low/high"
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows the nested model of the latest record", () => {
    const root = document.createElement("div") as unknown as Element
    const Loop = layerLoopLocal(NestedCounter, NestedPorts).pipe(Layer.provide(Layer.succeed(AutoActions, false)))
    const layer = layerPanel(NestedCounter, NestedPorts, { root, render, html }).pipe(Layer.provideMerge(Loop))
    return Effect.gen(function*() {
      const model = yield* NestedPorts.ModelPort

      yield* model.present({ _tag: "Inc", by: 1 })
      yield* model.present({ _tag: "Child", proposal: { _tag: "Inc", by: 3 } })
      yield* rowsRendered(root, 3)

      const detail = findElements(root as unknown as DomNode, "pre")[0]?.textContent ?? ""
      assert.deepStrictEqual(JSON.parse(detail).model, { parent: { count: 1 }, child: { count: 3 } })
    }).pipe(Effect.provide(layer))
  })
})
