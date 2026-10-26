import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { Document } from "uhtml/dom"
import init from "uhtml/init"
import { initial, type Model, type Representation, state } from "../../src/auction/Auction.ts"
import { Amount, Bidder } from "../../src/domain/Values.ts"
import { makeTickerViewWith } from "../../src/auction/Ticker.view.ts"

interface DomNode {
  readonly localName?: string
  readonly childNodes?: ArrayLike<DomNode>
  readonly textContent?: string
}

const findAll = (node: DomNode, localName: string): ReadonlyArray<DomNode> => [
  ...(node.localName === localName ? [node] : []),
  ...Array.from(node.childNodes ?? []).flatMap((child) => findAll(child, localName))
]

const document = new Document()
const { render, html } = init(document as unknown as globalThis.Document)
const view = makeTickerViewWith(html)("test")

const rendered = (representation: Representation) => {
  const root = document.createElement("div") as unknown as DomNode
  render(root as unknown as Element, view(representation))
  return {
    badge: findAll(root, "span").map((span) => span.textContent),
    highest: findAll(root, "p").map((line) => line.textContent),
    footer: findAll(root, "footer").map((footer) => footer.textContent)
  }
}

const bid = { bidder: Bidder.make("bob"), amount: Amount.make(25), at: 500 }
const open: Model = { ...initial, phase: "open", now: 1000, endsAt: 61_000, highest: Option.some(bid), bids: [bid] }

describe("ticker view", () => {
  it("shows the control state and that there is no bid yet", () => {
    const { badge, highest } = rendered(state(initial))

    assert.deepStrictEqual([badge, highest], [["opening"], ["highest: no bids"]])
  })

  it("shows the highest bid with its bidder", () => {
    const { badge, highest } = rendered(state(open))

    assert.deepStrictEqual([badge, highest], [["open"], ["highest: bob 25"]])
  })

  it("labels where the representations come from", () => {
    assert.deepStrictEqual(rendered(state(initial)).footer, ["test"])
  })
})
