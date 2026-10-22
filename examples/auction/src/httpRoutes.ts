import type { RpcTag } from "@mufw/rpc"
import { Effect, Layer, Stream } from "effect"
import { HttpRouter } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { layerAuthenticationServer } from "./adapters/authenticationServer.ts"
import { layerSessionsTable } from "./adapters/sessionsTable.ts"
import { Auction } from "./domain/Auction.ts"
import { samHttpPath } from "./samPath.ts"
import { ServerPorts, ServerRpc } from "./serverPorts.ts"

/**
 * What the HTTP endpoint routes, whatever `MUFW_RPCS` lets the socket serve: it is open to any
 * origin, so it only reads. A tag not listed is not routed.
 */
const HTTP_RPCS: ReadonlyArray<RpcTag> = ["Representations"]

/**
 * The loop's `ModelPort` for the HTTP handlers, whose `representations` keeps only the newest one for
 * a reader that falls behind. HTTP has no acks: once a client stops reading, the handler stops
 * pulling and an unbuffered subscription would keep every later representation until the connection
 * closes. Representations are snapshots, so a slow reader skipping to the latest loses nothing.
 */
export const layerLatestRepresentations = Layer.effect(ServerPorts.ModelPort)(
  Effect.gen(function*() {
    const model = yield* ServerPorts.ModelPort
    return {
      present: model.present,
      representations: model.representations.pipe(Stream.buffer({ capacity: 1, strategy: "sliding" }))
    }
  })
)

/**
 * `Representations` as a stream of NDJSON lines, one `POST` per subscription: the response stays
 * open and each representation is a line of it. Needs the server's loop and an `HttpRouter`; it
 * serves the same loop as the websocket route when both are built in one `HttpRouter.serve`.
 */
const layerRpcOverHttp = RpcServer.layer(ServerRpc.exposing(HTTP_RPCS)).pipe(
  Layer.provide(ServerRpc.layerHandlers.pipe(Layer.provide(layerLatestRepresentations))),
  Layer.provide(layerAuthenticationServer.pipe(Layer.provide(layerSessionsTable))),
  Layer.provide(RpcServer.layerProtocolHttp({ path: samHttpPath(Auction) })),
  Layer.provide(RpcSerialization.layerNdjson)
)

/**
 * A page on another origin (the vite dev server, a CDN) reads the stream with `fetch`, which
 * preflights a `POST` with a body type other than a form's. Credentials are never allowed, and
 * the middleware applies to every route of the router, not only this one: the websocket, which
 * browsers do not subject to it, and the HTML stream and the rendered page, which are public `GET`s.
 */
const layerCors = HttpRouter.cors({ allowedOrigins: [], allowedMethods: ["POST"] })

/** The read-only RPCs over HTTP at `samHttpPath(Auction)`, for any origin. Needs the server's loop. */
export const layerHttpRoutes = Layer.merge(layerRpcOverHttp, layerCors)
