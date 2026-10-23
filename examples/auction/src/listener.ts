import { NodeFileSystem, NodeHttpServer, type NodeServices } from "@effect/platform-node"
import type { PlatformError } from "effect"
import { Config, Duration, Effect, FileSystem, Layer, Option, Schema, Scope } from "effect"
import { type Etag, type HttpPlatform, HttpServer, type HttpServerError } from "effect/http"
import { createServer, type Server } from "node:http"
import { createSecureServer } from "node:http2"
import type { Socket } from "node:net"

/** `MUFW_TLS_CERT` and `MUFW_TLS_KEY` that do not come as a pair. */
export class TlsConfigError extends Schema.TaggedError<TlsConfigError>()("TlsConfigError", {
  message: Schema.String
}) {}

/** Paths of a PEM certificate chain and of its PEM private key. */
export interface TlsFiles {
  readonly cert: string
  readonly key: string
}

/**
 * `MUFW_TLS_CERT` and `MUFW_TLS_KEY`: with both set the listener serves HTTPS, negotiating HTTP/2 or
 * HTTP/1.1 per connection; with neither it serves plain HTTP/1.1. Each is read on its own so that
 * `resolveTlsFiles` can refuse a lone one instead of falling back to plain HTTP without a word.
 */
export const TlsFilesConfig = Config.all({
  cert: Config.NonEmptyString("MUFW_TLS_CERT").pipe(Config.option),
  key: Config.NonEmptyString("MUFW_TLS_KEY").pipe(Config.option)
})

/** What `TlsFilesConfig` reads: each path, if it is set. */
export interface TlsSettings {
  readonly cert: Option.Option<string>
  readonly key: Option.Option<string>
}

/** Both paths, neither, or a `TlsConfigError`. */
export const resolveTlsFiles = (settings: TlsSettings): Effect.Effect<Option.Option<TlsFiles>, TlsConfigError> => {
  const files = Option.all({ cert: settings.cert, key: settings.key })
  const unset = Option.isNone(settings.cert) && Option.isNone(settings.key)
  if (Option.isSome(files) || unset) return Effect.succeed(files)
  return Effect.fail(
    new TlsConfigError({
      message: "MUFW_TLS_CERT and MUFW_TLS_KEY go together: set both to serve HTTPS and HTTP/2, or neither to serve plain HTTP/1.1"
    })
  )
}

/** How long a stopping listener lets requests in flight finish before it interrupts them. */
export const SHUTDOWN_GRACE: Duration.Duration = Duration.seconds(2)

/** How long after that a client gets to answer a websocket close frame before its connection is destroyed. */
const CLOSE_HANDSHAKE: Duration.Duration = Duration.seconds(1)

/** Where the public listener binds, whether it speaks TLS, and how long it waits when it stops. */
export interface Listener {
  readonly port: number
  readonly tls: Option.Option<TlsFiles>
  readonly shutdownGrace?: Duration.Input
}

/** What a listener layer provides: the server, and the platform services its routes use. */
export type ListenerServices =
  | HttpServer.HttpServer
  | NodeServices.NodeServices
  | HttpPlatform.HttpPlatform
  | Etag.Generator

/** The listener could not start: the address is taken, or a TLS file cannot be read. */
export type ListenerFailure = HttpServerError.ServeError | PlatformError.PlatformError

const readCredentials = ({ cert, key }: TlsFiles) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return { cert: yield* fs.readFileString(cert), key: yield* fs.readFileString(key) }
  }).pipe(Effect.provide(NodeFileSystem.layer))

/**
 * `allowHTTP1` keeps one port serving both protocols: ALPN picks `h2` or `http/1.1` per connection.
 * The server emits `request` with `Http2ServerRequest`/`Http2ServerResponse` for `h2` and with
 * `IncomingMessage`/`ServerResponse` for `http/1.1`, and `upgrade` for HTTP/1.1 only, which is how
 * a websocket arrives. The cast stands for `Http2SecureServer`: `NodeHttpServer` types its server
 * as `http.Server` and relies only on the listening and event API the two share.
 */
const secureServer = (credentials: { readonly cert: string; readonly key: string }) => (): Server =>
  createSecureServer({ ...credentials, allowHTTP1: true }) as unknown as Server

/**
 * Every TCP connection the server accepts, upgraded websockets and HTTP/2 sessions included: the
 * `connection` event fires once per socket before any protocol sits on it, whereas `close()` and
 * `closeAllConnections()` leave an upgraded or HTTP/2 socket open.
 */
const trackConnections = (server: Server, open: Set<Socket>): Server => {
  server.on("connection", (socket: Socket) => {
    open.add(socket)
    socket.once("close", () => open.delete(socket))
  })
  return server
}

/**
 * `NodeHttpServer` for `create`, which on stopping waits `gracefulShutdownTimeout` for requests in
 * flight, interrupts the rest (a websocket gets its close frame), and `CLOSE_HANDSHAKE` later
 * destroys every connection still open. `server.close()` resolves only when the last connection
 * ends, and the websocket server's own close waits for its clients to answer the close frame, so
 * one open websocket, streaming response or mute client would keep the process alive and the
 * stopped instance answering its connected pages; those clients reconnect.
 *
 * Those two waits are finalizers `NodeHttpServer` registers in the scope it is built in, and the
 * websocket one is registered on the first upgrade, so nothing registered beside them can run
 * first. The server is therefore built in a scope of its own, closed here beside the timer that
 * destroys the connections.
 */
export const layerNodeServer = (
  create: () => Server,
  options: NodeHttpServer.Options
): Layer.Layer<ListenerServices, HttpServerError.ServeError> => {
  const server = Effect.gen(function*() {
    const open = new Set<Socket>()
    const serverScope = yield* Scope.make()
    const destroyAfterHandshake = Effect.sleep(CLOSE_HANDSHAKE).pipe(
      Effect.andThen(Effect.sync(() => open.forEach((socket) => socket.destroy()))),
      Effect.andThen(Effect.never)
    )
    yield* Effect.addFinalizer((exit) => Effect.raceFirst(Scope.close(serverScope, exit), destroyAfterHandshake))
    return yield* NodeHttpServer.make(() => trackConnections(create(), open), {
      gracefulShutdownTimeout: SHUTDOWN_GRACE,
      ...options
    }).pipe(Scope.provide(serverScope))
  })
  return Layer.merge(Layer.effect(HttpServer.HttpServer)(server), NodeHttpServer.layerHttpServices)
}

/**
 * The public `HttpServer`: HTTPS with HTTP/2 and an HTTP/1.1 fallback when `tls` names a
 * certificate, plain HTTP/1.1 otherwise. A file that cannot be read fails the layer.
 */
export const layerListener = ({ port, tls, shutdownGrace }: Listener): Layer.Layer<ListenerServices, ListenerFailure> => {
  const options: NodeHttpServer.Options = shutdownGrace === undefined
    ? { port }
    : { port, gracefulShutdownTimeout: shutdownGrace }
  return Option.match(tls, {
    onNone: () => layerNodeServer(createServer, options),
    onSome: (files) =>
      Layer.unwrap(
        readCredentials(files).pipe(Effect.map((credentials) => layerNodeServer(secureServer(credentials), options)))
      )
  })
}
