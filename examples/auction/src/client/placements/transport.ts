import { BrowserSocket } from "@effect/platform-browser"
import type { AnyDefinition } from "@mufw/core"
import { Effect, Layer, Schema } from "effect"
import { type RpcClient, RpcSerialization } from "effect/rpc"
import { samPath } from "../../samPath.ts"
import { layerProtocol } from "../connection.ts"
import { ServerOrigin } from "../serverOrigin.ts"

const decodeServerOrigin = Schema.decodeUnknownEffect(ServerOrigin)

const layerSocket = (def: AnyDefinition) =>
  Layer.unwrap(
    decodeServerOrigin(import.meta.env.VITE_SERVER_URL).pipe(
      Effect.map((origin) => BrowserSocket.layerWebSocket(`${origin}${samPath(def)}`))
    )
  )

/**
 * The connection to the server's endpoint for `def`, under `client`: that definition's RPC client,
 * which gets its protocol from here. The server's origin is a build-time setting of the deployment
 * (`VITE_SERVER_URL`, defaulted in `.env`); the path is the definition's (`samPath`). The origin is
 * decoded when the layer is built, so a bad value is a `SchemaError` in the layer's error channel
 * at the composition root. Call once per placement and definition: the returned layer value is
 * built once, so that definition's remote ports share one connection, and the protocol is built
 * afresh, so two definitions never share a socket. It provides `client` and `Connection`; a
 * placement merges `Connection` into its output with `Layer.provideMerge` so the page can show it.
 */
export const transport = <Client>(def: AnyDefinition, client: Layer.Layer<Client, never, RpcClient.Protocol>) =>
  client.pipe(
    Layer.provideMerge(Layer.fresh(layerProtocol)),
    Layer.provide(layerSocket(def)),
    Layer.provide(RpcSerialization.layerJson)
  )
