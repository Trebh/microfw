import { assert, describe, it } from "@effect/vitest"
import { DispatchRefused } from "@mufw/core"
import { layerMount } from "@mufw/view-uhtml"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Document } from "uhtml/dom"
import init from "uhtml/init"
import { layerAuthenticationAnonymous, layerAuthenticationClient } from "../src/authentication.ts"
import { SessionToken } from "../src/domain/Values.ts"
import { Ports, Rpc } from "../src/ports.ts"
import { layerRefusalNoticeWith } from "../src/client/refusalNotice.ts"
import { layerRefusals, Refusals } from "../src/client/refusals.ts"
import { makeAuctionViewWith } from "../src/auction/Auction.view.ts"
import { clientWith } from "./serverSide.ts"

interface DomNode {
  readonly localName?: string
  readonly childNodes?: ArrayLike<DomNode>
  readonly textContent?: string
  hasAttribute(name: string): boolean
  dispatchEvent(event: Event): boolean
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

/** Lets the other fibers run, so a page settles before the test looks at it. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 200 }))

/** Yields to the other fibers until the notice reads `text`; the last text seen is returned. */
const untilNoticeReads = (root: DomNode, text: string) =>
  Effect.yieldNow.pipe(
    Effect.andThen(Effect.sync(() => noticeText(root))),
    Effect.repeat({ until: (shown) => shown === text, times: 5000 })
  )

const refusal = new DispatchRefused({ intentTag: "Open", message: "No session" })

const reportRefusal = Refusals.use((refusals) => refusals.report(refusal))

describe("the refusal notice", () => {
  it.effect("shows the message of a refusal", () => {
    const root = newRoot()
    const layer = layerRefusalNoticeWith(html, render)(root as unknown as Element).pipe(
      Layer.provideMerge(layerRefusals)
    )
    return Effect.gen(function*() {
      yield* reportRefusal

      const shown = yield* untilNoticeReads(root, "Not sent: No session")

      assert.deepStrictEqual([shown, noticeHidden(root)], ["Not sent: No session", false])
    }).pipe(Effect.provide(layer))
  })

  it.effect("is hidden until a refusal is reported", () => {
    const root = newRoot()
    const layer = layerRefusalNoticeWith(html, render)(root as unknown as Element).pipe(
      Layer.provideMerge(layerRefusals)
    )
    return Effect.gen(function*() {
      const shown = yield* untilNoticeReads(root, "")

      assert.deepStrictEqual([shown, noticeHidden(root)], ["", true])
    }).pipe(Effect.provide(layer))
  })

  it.effect("clears itself once its time is up", () => {
    const root = newRoot()
    const layer = layerRefusalNoticeWith(html, render)(root as unknown as Element).pipe(
      Layer.provideMerge(layerRefusals)
    )
    return Effect.gen(function*() {
      yield* reportRefusal
      yield* untilNoticeReads(root, "Not sent: No session")

      yield* TestClock.adjust("6 seconds")
      const shown = yield* untilNoticeReads(root, "")

      assert.deepStrictEqual([shown, noticeHidden(root)], ["", true])
    }).pipe(Effect.provide(layer))
  })
})

/** A page whose server runs the actions, sending `authentication`; its refusals reach the notice. */
const pageOver = (authentication: typeof layerAuthenticationAnonymous, app: DomNode, strip: DomNode) => {
  const remote = Layer.merge(Rpc.layerIntentPortRemote, Rpc.layerModelRemote).pipe(
    Layer.provide(clientWith(authentication))
  )
  return Layer.merge(
    layerMount(Ports, {
      root: app as unknown as Element,
      view: makeAuctionViewWith(html)("test"),
      render,
      onRefused: (refused) => Refusals.use((refusals) => refusals.report(refused))
    }),
    layerRefusalNoticeWith(html, render)(strip as unknown as Element)
  ).pipe(Layer.provide(remote), Layer.provideMerge(layerRefusals))
}

const clickOpen = (app: DomNode) =>
  Effect.sync(() =>
    findAll(app, "button").find((button) => button.textContent === "Open auction")!.dispatchEvent(new Event("click"))
  )

describe("a page whose server refuses its session", () => {
  it.live("shows the refusal of a click the server refused", () => {
    const [app, strip] = [newRoot(), newRoot()]
    return Effect.gen(function*() {
      yield* untilNoticeReads(strip, "")
      yield* settle

      yield* clickOpen(app)
      const shown = yield* untilNoticeReads(strip, "Not sent: No session")

      assert.strictEqual(shown, "Not sent: No session")
    }).pipe(Effect.provide(pageOver(layerAuthenticationAnonymous, app, strip)))
  })
})
