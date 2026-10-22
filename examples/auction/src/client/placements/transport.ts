import { BrowserSocket } from "@effect/platform-browser"
import { Effect, Layer, Schema } from "effect"
import { type RpcMiddleware, RpcSerialization } from "effect/rpc"
import type { Authentication } from "../../authentication.ts"
import { Rpc } from "../../ports.ts"
import { layerProtocol } from "../connection.ts"

const WebSocketUrl = Schema.String.check(Schema.isPattern(/^wss?:\/\/.+/, { expected: "a ws:// or wss:// URL" }))

const decodeWebSocketUrl = Schema.decodeUnknownEffect(WebSocketUrl)

const layerSocket = Layer.unwrap(
  decodeWebSocketUrl(import.meta.env.VITE_SERVER_URL).pipe(Effect.map(BrowserSocket.layerWebSocket))
)

/**
 * The server's websocket URL is a build-time setting of the deployment (`VITE_SERVER_URL`, defaulted
 * in `.env`). It is decoded when the layer is built, so a bad value is a `SchemaError` in the layer's
 * error channel at the composition root. Call once per placement: the returned layer value is built
 * once, so all its remote ports share one connection. `authentication` is how the placement's
 * requests carry the session. It provides `Rpc.Client` and `Connection`; a placement merges
 * `Connection` into its output with `Layer.provideMerge` so the page can show it.
 */
export const transport = (authentication: Layer.Layer<RpcMiddleware.ForClient<Authentication>>) =>
  Rpc.layerClient.pipe(
    Layer.provide(authentication),
    Layer.provideMerge(layerProtocol),
    Layer.provide(layerSocket),
    Layer.provide(RpcSerialization.layerJson)
  )
