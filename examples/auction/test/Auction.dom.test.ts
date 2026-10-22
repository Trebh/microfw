import { Effect } from "effect"
import { Document } from "uhtml/dom"
import init from "uhtml/init"
import { describeDomPaths, type DomNode } from "./dom.ts"

const document = new Document()
const { html, render } = init(document as unknown as globalThis.Document)
// uhtml's fake elements set `currentTarget` only on uhtml's own `Event`.
const { Event } = document.defaultView

describeDomPaths({
  html,
  render,
  // uhtml's fake element has every member of `DomNode`; its declared types differ from the DOM's.
  createRoot: () => document.createElement("div") as unknown as DomNode,
  gestures: {
    click: (element) =>
      Effect.sync(() => {
        element.dispatchEvent(new Event("click"))
      }),
    fill: (input, text) =>
      Effect.sync(() => {
        input.value = text
      }),
    submit: (form) =>
      Effect.sync(() => {
        form.dispatchEvent(new Event("submit"))
      })
  },
  pace: 0
})
