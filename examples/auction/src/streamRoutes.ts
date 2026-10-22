import { makeSsr, type Ssr } from "@mufw/view-uhtml/ssr"
import { Effect, Schema, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { Auction, type Representation } from "./domain/Auction.ts"
import { ServerPorts } from "./serverPorts.ts"
import { renderApp } from "./ssr.ts"

/**
 * The definitions this server streams, by the name in the URL. Anything else is a 404 before a
 * subscription is made.
 */
const StreamName = Schema.Literals([Auction.name])

/** The footer of the view: this page has no placement of its own and no identity, only the server's loop. */
const LABEL = "html stream · display only"

/** The `<template>` that carries the next markup; each replacement removes it, so ids never repeat in the document. */
const NEXT_ID = "mufw-next"

/**
 * The only script of the page. It moves a template's parsed content into `#app` and removes the
 * template and the `<script>` that called it, so the document does not grow with every update. The
 * markup never appears in script source: it is the content of a `<template>`, which the parser
 * cannot end early the way it can end a script or an attribute.
 */
const REPLACE_SCRIPT = `function mufwReplace(){const next=document.getElementById("${NEXT_ID}");` +
  `document.getElementById("app").replaceChildren(next.content);next.remove();document.currentScript.remove()}`

/** The view's own classes, restated here because the page loads no stylesheet and no bundle. */
const STYLE = [
  "body{font-family:system-ui,sans-serif;margin:1rem}",
  "fieldset{border:0;margin:0;padding:0;min-width:0}",
  "header{display:flex;gap:1rem;align-items:baseline}",
  ".badge{padding:.1rem .5rem;border-radius:.5rem;background:#ddd}",
  ".badge.open{background:#cfc}.badge.closing{background:#fd9}.badge.sold{background:#fbb}.badge.opening{background:#cde}",
  ".rejection{color:#c00;min-height:1.2em}",
  "footer{color:#666;font-size:.85rem}"
].join("")

/**
 * The head of the document and the opening of its body. `<html>` and `<body>` stay open, since the
 * update chunks that follow are more body.
 */
const DOCUMENT_START = [
  "<!doctype html>",
  "<html lang=\"en\">",
  "<head>",
  "<meta charset=\"utf-8\">",
  "<title>µFW auction · html stream</title>",
  `<style>${STYLE}</style>`,
  `<script>${REPLACE_SCRIPT}</script>`,
  "</head>",
  "<body>",
  ""
].join("\n")

/**
 * One chunk per representation. `representations` emits the current one first: it is the
 * document's own markup and is not rendered a second time as an update. The
 * `<fieldset disabled>` makes every control of the view inert in the platform itself, without taking
 * the content out of the accessibility tree: nothing on this page can bid, with or without script.
 * An update is the next markup in a template and the call that swaps it into `#app`; its newline is
 * inside the script, so that removing the script leaves no text behind in the body.
 *
 * The subscription is drained into a buffer of one, the newest: a client that stops reading would
 * otherwise make the server queue every representation behind the socket. A slow reader skips to the
 * latest view and never sees the ones in between.
 */
export const chunks = (ssr: Ssr, representations: Stream.Stream<Representation>) =>
  representations.pipe(
    Stream.buffer({ capacity: 1, strategy: "sliding" }),
    Stream.map((representation, index) => {
      const markup = renderApp(ssr, LABEL, representation)
      if (index > 0) return `<template id="${NEXT_ID}">${markup}</template><script>mufwReplace()\n</script>`
      return `${DOCUMENT_START}<fieldset disabled><div id="app">${markup}</div></fieldset>\n`
    }),
    Stream.encodeText
  )

const notFound = HttpServerResponse.text("Not Found", { status: 404 })

/**
 * The response body is the stream itself: the Node server writes each chunk as it is emitted and
 * interrupts the request's fiber when the client closes the connection, which closes the
 * subscription to `representations`. `no-store` and `x-accel-buffering` keep caches and proxies from
 * holding chunks back; `nosniff` keeps the browser from buffering the start of the body to guess a type.
 */
const serveStream = (ssr: Ssr, representations: Stream.Stream<Representation>) =>
  Effect.gen(function*() {
    const params = yield* HttpRouter.params
    yield* Schema.decodeUnknownEffect(StreamName)(params["name"])
    return HttpServerResponse.stream(chunks(ssr, representations), {
      contentType: "text/html; charset=utf-8",
      headers: {
        "cache-control": "no-store",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff"
      }
    })
  }).pipe(Effect.catchTag("SchemaError", () => Effect.succeed(notFound)))

/**
 * `GET /stream/<name>` answers with the auction's view as HTML that never ends: the server-rendered
 * document first, then a chunk per later representation that replaces `#app`'s content. The page
 * needs no client bundle, shows what `Representations` shows and accepts nothing, so the server
 * serves it whatever `MUFW_RPCS` says. Needs the server's `ModelPort`; `<name>` that no served
 * definition has is a 404.
 */
export const layerStreamRoutes = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const model = yield* ServerPorts.ModelPort
    yield* router.add("GET", "/stream/:name", serveStream(makeSsr(), model.representations))
  })
)
