import { BrowserSocket } from "@effect/platform-browser"
import { Layer } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Rpc } from "../../ports.ts"

const SERVER_URL = "ws://localhost:3001/sam"

/** Call once per placement: the returned layer value is built once, so all its remote ports share one connection. */
export const transport = () =>
  Rpc.layerClient.pipe(
    Layer.provide(RpcClient.layerProtocolSocket()),
    Layer.provide(BrowserSocket.layerWebSocket(SERVER_URL)),
    Layer.provide(RpcSerialization.layerJson)
  )
