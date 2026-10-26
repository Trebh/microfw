import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { layerAuthenticationAnonymous } from "../../authentication.ts"
import { Auction } from "../../auction/Auction.ts"
import { Rpc } from "../../ports.ts"
import { samHttpPath } from "../../samPath.ts"
import { HttpServerOrigin } from "../serverOrigin.ts"

/**
 * The RPC client of the server's endpoint at `url`, which is prefixed to the requests of the
 * `HttpClient` in context, with one NDJSON stream per streaming call. It sends no session, so the
 * server refuses any call that runs actions.
 */
export const layerClientOverHttp = (url: string) =>
  Rpc.layerClient.pipe(
    Layer.provide(layerAuthenticationAnonymous),
    Layer.provide(RpcClient.layerProtocolHttp({ url })),
    Layer.provide(RpcSerialization.layerNdjson)
  )

/**
 * The server's `ModelPort` and nothing else, read over one streaming HTTP request: no intents, no
 * actions, no history, and no socket. A cut stream is requested again, as a lost socket is
 * redialled (`@mufw/rpc`). Needs the server to serve `Representations` over HTTP (`httpRoutes.ts`).
 */
export const layerModelOverHttp = (url: string) => Rpc.layerModelRemote.pipe(Layer.provide(layerClientOverHttp(url)))

const decodeHttpOrigin = Schema.decodeUnknownEffect(HttpServerOrigin)

/**
 * `layerModelOverHttp` at the server of this build (`VITE_SERVER_URL`, a ws origin read as its
 * http one), over the browser's `fetch`. The origin is decoded when the layer is built, so a bad
 * value is a `SchemaError` in the layer's error channel at the composition root.
 */
export const httpReadOnly = Layer.unwrap(
  decodeHttpOrigin(import.meta.env.VITE_SERVER_URL).pipe(
    Effect.map((origin) => layerModelOverHttp(`${origin}${samHttpPath(Auction)}`))
  )
).pipe(Layer.provide(FetchHttpClient.layer))
