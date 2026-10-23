import { Effect, Layer, Stream } from "effect"
import { html, render } from "uhtml"
import { Connection, type ConnectionState } from "./connection.ts"

const messages: Record<ConnectionState, string> = {
  connecting: "connecting…",
  connected: "",
  disconnected: "disconnected, reconnecting…"
}

/** Pure view of the transport state; hidden while connected, so a page with no remote port shows nothing. */
export const connectionBanner = (state: ConnectionState) =>
  html`<p class="connection" role="status" ?hidden=${state === "connected"}>${messages[state]}</p>`

/** Re-renders the banner into `root` on every change of `Connection`. */
export const layerConnectionBanner = (root: Element) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const connection = yield* Connection
      yield* Effect.forkScoped(
        Stream.runForEach(connection, (state) => Effect.sync(() => render(root, connectionBanner(state))))
      )
    })
  )
