import "../src/client/style.css"
import { Effect } from "effect"
import { html, render } from "uhtml"
import { server, userEvent } from "vitest/browser"
import { describeDomPaths, type DomNode } from "./dom.ts"

// Every `DomNode` here is an element of this page's document.
const element = (node: DomNode) => node as unknown as Element

const watched = !server.config.browser.headless

describeDomPaths({
  html,
  render,
  createRoot: () => {
    const root = document.createElement("div")
    document.body.replaceChildren(root)
    return root
  },
  gestures: {
    click: (node) => Effect.promise(() => userEvent.click(element(node))),
    fill: (node, text) => Effect.promise(() => userEvent.fill(element(node), text)),
    submit: (_form, button) => Effect.promise(() => userEvent.click(element(button)))
  },
  pace: watched ? "700 millis" : 0
})
