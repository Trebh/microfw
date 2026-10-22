import { assert, describe, it } from "@effect/vitest"
import { Document } from "uhtml/dom"
import init from "uhtml/init"
import { type Representation, state } from "../src/domain/Wallet.ts"
import { makeWalletViewWith } from "../src/walletViewTemplate.ts"

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
const view = makeWalletViewWith(html)("test")

const rendered = (representation: Representation) => {
  const root = document.createElement("div") as unknown as DomNode
  render(root as unknown as Element, view(representation, () => {}))
  return {
    badge: findAll(root, "span").map((span) => span.textContent),
    figures: findAll(root, "p").map((figure) => figure.textContent),
    footer: findAll(root, "footer").map((footer) => footer.textContent)
  }
}

describe("wallet view", () => {
  it("shows the control state and the credit, reserved and available figures", () => {
    const { badge, figures } = rendered(state({ credit: 100, reserved: 40 }))

    assert.deepStrictEqual([badge, figures], [["funded"], ["credit: 100", "reserved: 40", "available: 60"]])
  })

  it("shows an exhausted wallet", () => {
    const { badge, figures } = rendered(state({ credit: 100, reserved: 100 }))

    assert.deepStrictEqual([badge, figures], [["exhausted"], ["credit: 100", "reserved: 100", "available: 0"]])
  })

  it("labels whose wallet it is", () => {
    assert.deepStrictEqual(rendered(state({ credit: 100, reserved: 0 })).footer, ["test"])
  })
})
