import { HeldRequests } from "@mufw/rpc"
import { Effect, Layer, Stream } from "effect"
import type { html as Html, render as Render } from "uhtml"

const describeHeld = (held: number) =>
  held === 1 ? "1 action will be sent once reconnected" : `${held} actions will be sent once reconnected`

/**
 * Pure view of how many intents wait for the connection; hidden while none does. It takes uhtml's
 * `html` as a parameter because the entry module needs a DOM at import time, so a test brings its
 * own document.
 */
export const makeHeldNoticeWith = (html: typeof Html) => (held: number) =>
  html`<p class="held" role="status" ?hidden=${held === 0}>${held === 0 ? "" : describeHeld(held)}</p>`

/**
 * Re-renders the notice into `root` on every change of `HeldRequests`. A page whose transport holds
 * no requests reads 0 and shows nothing.
 */
export const layerHeldNoticeWith = (html: typeof Html, render: typeof Render) => (root: Element) => {
  const notice = makeHeldNoticeWith(html)
  return Layer.effectDiscard(
    Effect.gen(function*() {
      const held = yield* HeldRequests
      yield* Effect.forkScoped(Stream.runForEach(held, (count) => Effect.sync(() => render(root, notice(count)))))
    })
  )
}
