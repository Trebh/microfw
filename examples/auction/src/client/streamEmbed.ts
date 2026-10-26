import { BrowserRuntime } from "@effect/platform-browser"
import { Effect, Schema } from "effect"
import { Auction } from "../auction/Auction.ts"
import { samStreamPath } from "../samPath.ts"
import { HttpServerOrigin } from "./serverOrigin.ts"

const decodeHttpOrigin = Schema.decodeUnknownEffect(HttpServerOrigin)

/**
 * Points `frame` at the server's HTML stream (`VITE_SERVER_URL`, a ws origin read as its http one)
 * once this page has loaded: a frame whose document never ends keeps the page's own `load` from
 * firing. The frame is the whole island: the document it loads carries its own markup and its own
 * update script, so this page ships no code to draw or update it. A bad origin is a `SchemaError`,
 * which `runMain` reports.
 */
export const runStreamFrame = (frame: Element) => {
  const show = decodeHttpOrigin(import.meta.env.VITE_SERVER_URL).pipe(
    Effect.map((origin) => {
      const point = () => frame.setAttribute("src", `${origin}${samStreamPath(Auction)}`)
      if (document.readyState === "complete") point()
      else window.addEventListener("load", point, { once: true })
    })
  )
  BrowserRuntime.runMain(show)
}
