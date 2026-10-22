import type { Hole, html as Html } from "uhtml"
import { Document } from "uhtml/dom"
import init from "uhtml/init"

/** A uhtml bound to a fake document, and the markup it renders a template to. */
export interface Ssr {
  /** The `html` tag to build views with; its templates render with `toString`. */
  readonly html: typeof Html
  /** The markup of `hole`, as the children of a detached element. */
  readonly toString: (hole: Hole) => string
}

/**
 * Builds a uhtml on `uhtml/dom`'s `Document`, so a view renders without a browser. This entry
 * imports uhtml statically: it is for Node composition roots, while `index.ts` loads uhtml lazily
 * because the real entry module needs a DOM at import time.
 */
export const makeSsr = (): Ssr => {
  const document = new Document() as unknown as globalThis.Document
  const { html, render } = init(document)
  // A new root per call: `render` caches the previous template on its target.
  const toString = (hole: Hole) => {
    const root = document.createElement("div")
    render(root, hole)
    return root.innerHTML
  }
  return { html, toString }
}
