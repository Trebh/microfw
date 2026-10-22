import { Schema, SchemaTransformation } from "effect"

/** `VITE_SERVER_URL`: the websocket origin of the server, without a path. */
export const ServerOrigin = Schema.String.check(
  Schema.isPattern(/^wss?:\/\/[^/?#]+$/, { expected: "a ws:// or wss:// origin without a path" })
)

/**
 * The same origin for HTTP: `ws://` is `http://` and `wss://` is `https://`, so one setting names
 * the server for both of its protocols.
 */
export const HttpServerOrigin = ServerOrigin.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (origin: string) => origin.replace(/^ws/, "http"),
      encode: (origin: string) => origin.replace(/^http/, "ws")
    })
  )
)
