import { assert, describe, it } from "@effect/vitest"
import { HeldRequests } from "@mufw/rpc"
import { Effect, Layer, Stream } from "effect"
import { Document } from "uhtml/dom"
import init from "uhtml/init"
import { layerHeldNoticeWith } from "../src/client/heldNotice.ts"

interface DomNode {
  readonly localName?: string
  readonly childNodes?: ArrayLike<DomNode>
  readonly textContent?: string
  hasAttribute(name: string): boolean
}

const findAll = (node: DomNode, localName: string): ReadonlyArray<DomNode> => [
  ...(node.localName === localName ? [node] : []),
  ...Array.from(node.childNodes ?? []).flatMap((child) => findAll(child, localName))
]

const document = new Document()
const { render, html } = init(document as unknown as globalThis.Document)

const newRoot = () => document.createElement("div") as unknown as DomNode

const notice = (root: DomNode) => findAll(root, "p")[0]

const noticeText = (root: DomNode) => notice(root)?.textContent

const noticeHidden = (root: DomNode) => notice(root)?.hasAttribute("hidden")

/** Yields to the other fibers until the notice reads `text`; the last text seen is returned. */
const untilNoticeReads = (root: DomNode, text: string) =>
  Effect.yieldNow.pipe(
    Effect.andThen(Effect.sync(() => noticeText(root))),
    Effect.repeat({ until: (shown) => shown === text, times: 5000 })
  )

const noticeOver = (root: DomNode, held: Stream.Stream<number>) =>
  layerHeldNoticeWith(html, render)(root as unknown as Element).pipe(
    Layer.provide(Layer.succeed(HeldRequests, held))
  )

describe("the held notice", () => {
  it.effect("says how many actions wait for the connection", () => {
    const root = newRoot()
    return Effect.gen(function*() {
      const shown = yield* untilNoticeReads(root, "2 actions will be sent once reconnected")

      assert.deepStrictEqual([shown, noticeHidden(root)], ["2 actions will be sent once reconnected", false])
    }).pipe(Effect.provide(noticeOver(root, Stream.make(2))))
  })

  it.effect("says it in the singular for one action", () => {
    const root = newRoot()
    return Effect.gen(function*() {
      const shown = yield* untilNoticeReads(root, "1 action will be sent once reconnected")

      assert.deepStrictEqual([shown, noticeHidden(root)], ["1 action will be sent once reconnected", false])
    }).pipe(Effect.provide(noticeOver(root, Stream.make(1))))
  })

  it.effect("is hidden once nothing waits", () => {
    const root = newRoot()
    return Effect.gen(function*() {
      const shown = yield* untilNoticeReads(root, "")

      assert.deepStrictEqual([shown, noticeHidden(root)], ["", true])
    }).pipe(Effect.provide(noticeOver(root, Stream.make(2, 0))))
  })

  it.effect("is hidden on a page whose transport holds no requests", () => {
    const root = newRoot()
    return Effect.gen(function*() {
      const shown = yield* untilNoticeReads(root, "")

      assert.deepStrictEqual([shown, noticeHidden(root)], ["", true])
    }).pipe(Effect.provide(layerHeldNoticeWith(html, render)(root as unknown as Element)))
  })
})
