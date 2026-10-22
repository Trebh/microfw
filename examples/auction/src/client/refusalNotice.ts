import { Effect, Layer, Option, Stream } from "effect"
import type { html as Html, render as Render } from "uhtml"
import { expiring, type Refusal, Refusals } from "./refusals.ts"

/**
 * Pure view of the latest refusal; hidden while there is none. It takes uhtml's `html` as a
 * parameter because the entry module needs a DOM at import time, so a test brings its own document.
 */
export const makeRefusalNoticeWith = (html: typeof Html) => (refusal: Refusal) =>
  html`<p class="refusal" role="alert" ?hidden=${Option.isNone(refusal)}>${
    Option.match(refusal, { onNone: () => "", onSome: (refused) => `Not sent: ${refused.message}` })
  }</p>`

/** Re-renders the notice into `root` on every change of `Refusals`, and clears it when its time is up. */
export const layerRefusalNoticeWith = (html: typeof Html, render: typeof Render) => (root: Element) => {
  const notice = makeRefusalNoticeWith(html)
  return Layer.effectDiscard(
    Effect.gen(function*() {
      const refusals = yield* Refusals
      yield* Effect.forkScoped(
        Stream.runForEach(expiring(refusals.latest), (refusal) => Effect.sync(() => render(root, notice(refusal))))
      )
    })
  )
}
