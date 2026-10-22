import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { Document } from "uhtml/dom"
import init from "uhtml/init"
import { type Intent, initial, type Representation, state } from "../src/domain/Auction.ts"
import { makeViewWith } from "../src/viewTemplate.ts"

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
const view = makeViewWith(html)("test")

const rendered = (representation: Representation) => {
  const root = document.createElement("div") as unknown as DomNode
  const dispatched: Array<Intent> = []
  render(root as unknown as Element, view(representation, (intent) => dispatched.push(intent)))
  const buttons = findAll(root, "button")
  return {
    dispatched,
    inputDisabled: findAll(root, "input").map((input) => input.hasAttribute("disabled")),
    buttonLabels: buttons.map((button) => button.textContent),
    bidButtonDisabled: buttons.find((button) => button.textContent === "Place bid")?.hasAttribute("disabled"),
    openButton: buttons.find((button) => button.textContent === "Open auction")
  }
}

const opening = state(initial)
const open: Representation = { ...opening, controlState: "open" }
const sold: Representation = { ...opening, controlState: "sold", highest: Option.none() }

describe("auction view while opening", () => {
  it("disables the bid form", () => {
    const { bidButtonDisabled, inputDisabled } = rendered(opening)

    assert.deepStrictEqual([bidButtonDisabled, inputDisabled], [true, [true]])
  })

  it("offers an Open auction control that dispatches Open", () => {
    const { openButton, dispatched } = rendered(opening)

    openButton!.dispatchEvent(new Event("click"))

    assert.deepStrictEqual(dispatched, [{ _tag: "Open" }])
  })
})

describe("auction view once opened", () => {
  it("enables the bid form", () => {
    const { bidButtonDisabled, inputDisabled } = rendered(open)

    assert.deepStrictEqual([bidButtonDisabled, inputDisabled], [false, [false]])
  })

  it("does not offer the Open auction control", () => {
    assert.deepStrictEqual(rendered(open).buttonLabels, ["Place bid"])
  })
})

describe("auction view once sold", () => {
  it("disables the bid form", () => {
    assert.strictEqual(rendered(sold).bidButtonDisabled, true)
  })
})
