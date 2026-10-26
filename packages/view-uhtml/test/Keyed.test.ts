import { assert, describe, it } from "@effect/vitest"
import { Document } from "uhtml/dom"
import init from "uhtml/init"
import { makeKeyedList } from "../src/index.ts"

const { htmlFor, render, html } = init(new Document() as unknown as globalThis.Document)

interface Item {
  readonly id: number
  readonly label: string
}

const item = (id: number, label = `item ${id}`): Item => ({ id, label })

const keyedItems = () => {
  const list = makeKeyedList(htmlFor)
  return (items: ReadonlyArray<Item>) =>
    list(items, (entry) => entry.id, (tag, entry) => tag`<li>${entry.label}</li>`)
}

describe("makeKeyedList", () => {
  it("renders the same node for a key that is kept across renders", () => {
    const renderItems = keyedItems()
    const first = renderItems([item(1), item(2)])

    const second = renderItems([item(1), item(2)])

    assert.strictEqual(second[0], first[0])
    assert.strictEqual(second[1], first[1])
  })

  it("keeps the node of every key when the list is reordered", () => {
    const renderItems = keyedItems()
    const [one, two, three] = renderItems([item(1), item(2), item(3)])

    const reordered = renderItems([item(3), item(1), item(2)])

    assert.strictEqual(reordered[0], three)
    assert.strictEqual(reordered[1], one)
    assert.strictEqual(reordered[2], two)
  })

  it("updates the text of a kept node in place", () => {
    const renderItems = keyedItems()
    const [before] = renderItems([item(1, "old")])

    const [after] = renderItems([item(1, "new")])

    assert.strictEqual(after, before)
    assert.strictEqual(after?.textContent, "new")
  })

  it("gives a key that was absent from one render a new node when it returns", () => {
    const renderItems = keyedItems()
    const [original] = renderItems([item(1)])
    renderItems([])

    const [returned] = renderItems([item(1)])

    assert.notStrictEqual(returned, original)
  })

  it("keeps the node of a key that stays while another is dropped", () => {
    const renderItems = keyedItems()
    const [kept] = renderItems([item(1), item(2)])
    renderItems([item(1)])

    const [stillKept] = renderItems([item(1), item(2)])

    assert.strictEqual(stillKept, kept)
  })

  it("keeps two lists apart: one list's render does not drop the other's keys", () => {
    const rows = keyedItems()
    const cells = keyedItems()
    const [row] = rows([item(1)])
    cells([])

    const [sameRow] = rows([item(1)])

    assert.strictEqual(sameRow, row)
  })

  it("renders a key repeated within one render as one node with the last item's values", () => {
    const renderItems = keyedItems()

    const nodes = renderItems([item(1, "a"), item(1, "b"), item(2, "c")])

    const texts = Array.from(new Set(nodes), (node) => node.textContent)
    assert.deepStrictEqual(texts, ["b", "c"])
  })

  it("lays the nodes out in order inside an array hole", () => {
    const renderItems = keyedItems()
    const root = new Document().createElement("ul") as unknown as Element

    render(root, html`<ul>${renderItems([item(2), item(1)])}</ul>`)

    assert.strictEqual(root.innerHTML, "<ul><li>item 2</li><li>item 1</li><!--[2]--></ul>")
  })
})
