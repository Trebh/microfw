import { NodeFileSystem, NodeSocket } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Context, Deferred, Effect, Exit, FileSystem, Layer, Option, Scope, Stream } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { get as httpGet } from "node:http"
import { get as httpsGet } from "node:https"
import { connect as http2Connect } from "node:http2"
import { connect as netConnect } from "node:net"
import { layerListener, resolveTlsFiles, type TlsFiles, TlsFilesConfig } from "../src/listener.ts"
import { selfSignedLocalhost } from "./selfSignedCertificate.ts"

const certificate = selfSignedLocalhost()

/** The certificate and key as files in a directory that goes with the scope, which is how the server is given them. */
const tlsFiles = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  const files: TlsFiles = { cert: `${directory}/cert.pem`, key: `${directory}/key.pem` }
  yield* fs.writeFileString(files.cert, certificate.cert)
  yield* fs.writeFileString(files.key, certificate.key)
  return files
}).pipe(Effect.provide(NodeFileSystem.layer))

const Routes = Layer.effectDiscard(
  Effect.gen(function*() {
    const router = yield* HttpRouter.HttpRouter
    yield* router.add("GET", "/hello", Effect.succeed(HttpServerResponse.text("hello")))
    // The first chunk is all a client gets until it hangs up, like `/stream/<name>` between two steps.
    const unfinished = Stream.make("first").pipe(Stream.concat(Stream.never), Stream.encodeText)
    yield* router.add("GET", "/unfinished", Effect.succeed(HttpServerResponse.stream(unfinished)))
    yield* router.add(
      "GET",
      "/socket",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const socket = yield* Effect.orDie(request.upgrade)
        // The socket opens when its reader is acquired, and its writer waits for that.
        yield* Effect.orDie(socket.reader)
        const writer = yield* socket.writer
        yield* Effect.orDie(writer.write("welcome"))
        return yield* Effect.never
      })
    )
  })
)

/** The routes on a listener of port 0 that lives as long as the scope, and the port it got. */
const serve = (tls: Option.Option<TlsFiles>) =>
  Effect.gen(function*() {
    const served = HttpRouter.serve(Routes, { disableListenLog: true }).pipe(
      Layer.provideMerge(layerListener({ port: 0, tls }))
    )
    const server = Context.get(yield* Layer.build(served), HttpServer.HttpServer)
    return "port" in server.address ? server.address.port : 0
  })

interface Answer {
  readonly protocol: string
  readonly status: number
  readonly body: string
}

/** `GET path` on a TLS listener over an HTTP/2 session that trusts the test certificate. */
const getOverHttp2 = (port: number, path: string) =>
  Effect.callback<Answer, Error>((resume) => {
    const session = http2Connect(`https://localhost:${port}`, { ca: certificate.cert })
    const request = session.request({ ":path": path })
    let status = 0
    let body = ""
    request.setEncoding("utf8")
    request.on("response", (headers) => {
      status = Number(headers[":status"])
    })
    request.on("data", (chunk: string) => {
      body += chunk
    })
    request.on("end", () => {
      const protocol = session.alpnProtocol ?? "none"
      session.close()
      resume(Effect.succeed({ protocol, status, body }))
    })
    session.on("error", (error) => resume(Effect.fail(error)))
    return Effect.sync(() => session.destroy())
  })

/** `GET path` on a TLS listener over HTTP/1.1, as a client that offers no `h2` does. */
const getOverHttps = (port: number, path: string) =>
  Effect.callback<Answer, Error>((resume) => {
    const request = httpsGet(`https://localhost:${port}${path}`, { ca: certificate.cert, agent: false }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk: string) => {
        body += chunk
      })
      response.on("end", () => {
        resume(Effect.succeed({ protocol: `http/${response.httpVersion}`, status: response.statusCode ?? 0, body }))
      })
    })
    request.on("error", (error) => resume(Effect.fail(error)))
    return Effect.sync(() => request.destroy())
  })

/** `GET path` on a plain listener. */
const getOverHttp = (port: number, path: string) =>
  Effect.callback<Answer, Error>((resume) => {
    const request = httpGet(`http://localhost:${port}${path}`, { agent: false }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk: string) => {
        body += chunk
      })
      response.on("end", () => {
        resume(Effect.succeed({ protocol: `http/${response.httpVersion}`, status: response.statusCode ?? 0, body }))
      })
    })
    request.on("error", (error) => resume(Effect.fail(error)))
    return Effect.sync(() => request.destroy())
  })

/** The first chunk of `/unfinished` over HTTP/2, read while the response is still open. */
const firstChunkOverHttp2 = (port: number) =>
  Effect.callback<string, Error>((resume) => {
    const session = http2Connect(`https://localhost:${port}`, { ca: certificate.cert })
    const request = session.request({ ":path": "/unfinished" })
    request.setEncoding("utf8")
    request.once("data", (chunk: string) => {
      session.destroy()
      resume(Effect.succeed(chunk))
    })
    session.on("error", (error) => resume(Effect.fail(error)))
    return Effect.sync(() => session.destroy())
  })

/** The first message the server sends over a websocket at `/socket` on a TLS listener. */
const firstSocketMessage = (port: number) =>
  Effect.callback<string, Error>((resume) => {
    const socket = new NodeSocket.NodeWS.WebSocket(`wss://localhost:${port}/socket`, { ca: certificate.cert })
    socket.on("message", (message) => {
      socket.terminate()
      resume(Effect.succeed(message.toString()))
    })
    socket.on("error", (error) => resume(Effect.fail(error)))
    return Effect.sync(() => socket.terminate())
  })

describe("layerListener with a certificate", () => {
  it.effect("negotiates h2 and answers a request over it", () =>
    Effect.gen(function*() {
      const tls = Option.some(yield* tlsFiles)
      const port = yield* serve(tls)

      const answer = yield* getOverHttp2(port, "/hello")

      assert.deepStrictEqual(answer, { protocol: "h2", status: 200, body: "hello" })
    }).pipe(Effect.scoped))

  it.effect("falls back to HTTP/1.1 for a client that does not offer h2", () =>
    Effect.gen(function*() {
      const tls = Option.some(yield* tlsFiles)
      const port = yield* serve(tls)

      const answer = yield* getOverHttps(port, "/hello")

      assert.deepStrictEqual(answer, { protocol: "http/1.1", status: 200, body: "hello" })
    }).pipe(Effect.scoped))

  it.effect("delivers the first chunk of a response that never ends, over h2", () =>
    Effect.gen(function*() {
      const tls = Option.some(yield* tlsFiles)
      const port = yield* serve(tls)

      const chunk = yield* firstChunkOverHttp2(port)

      assert.strictEqual(chunk, "first")
    }).pipe(Effect.scoped))

  it.effect("upgrades a websocket on the same port", () =>
    Effect.gen(function*() {
      const tls = Option.some(yield* tlsFiles)
      const port = yield* serve(tls)

      const message = yield* firstSocketMessage(port)

      assert.strictEqual(message, "welcome")
    }).pipe(Effect.scoped))

  it.effect("fails to start when a file cannot be read", () =>
    Effect.gen(function*() {
      const missing = Option.some({ cert: "/nonexistent/cert.pem", key: "/nonexistent/key.pem" })

      const failure = yield* Effect.flip(Layer.build(layerListener({ port: 0, tls: missing })))

      assert.strictEqual(failure._tag, "PlatformError")
    }).pipe(Effect.scoped))
})

describe("layerListener without a certificate", () => {
  it.effect("serves plain HTTP/1.1", () =>
    Effect.gen(function*() {
      const port = yield* serve(Option.none())

      const answer = yield* getOverHttp(port, "/hello")

      assert.deepStrictEqual(answer, { protocol: "http/1.1", status: 200, body: "hello" })
    }).pipe(Effect.scoped))
})

/** The grace the stopping tests give requests in flight, short so that a test waits for it only briefly. */
const GRACE_MILLIS = 100

/** A stopping listener must finish within this, which is many times the grace and far under the 20 s `NodeHttpServer` waits by default. */
const STOP_BOUND = "3 seconds"

/** The routes on a listener of port 0 that lives until `stop` runs, and the port it got. */
const serveUntilStopped = (tls: Option.Option<TlsFiles>) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const served = HttpRouter.serve(Routes, { disableListenLog: true }).pipe(
      Layer.provideMerge(layerListener({ port: 0, tls, shutdownGrace: GRACE_MILLIS }))
    )
    const server = Context.get(yield* Layer.buildWithScope(served, scope), HttpServer.HttpServer)
    const port = "port" in server.address ? server.address.port : 0
    return { port, stop: Scope.close(scope, Exit.void) }
  })

/** A websocket at `/socket` that has received its first message, and an effect that finishes when the client sees the connection closed. */
const openSocket = (url: string) =>
  Effect.gen(function*() {
    const closed = yield* Deferred.make<void>()
    yield* Effect.callback<void, Error>((resume) => {
      const socket = new NodeSocket.NodeWS.WebSocket(url, { ca: certificate.cert })
      socket.on("message", () => resume(Effect.void))
      socket.on("error", (error) => resume(Effect.fail(error)))
      socket.on("close", () => Deferred.doneUnsafe(closed, Effect.void))
      return Effect.sync(() => socket.terminate())
    })
    return Deferred.await(closed)
  })

/** `/unfinished` over HTTP/2 after its first chunk arrived, and an effect that finishes when the client sees the session closed. */
const openStream = (port: number) =>
  Effect.gen(function*() {
    const closed = yield* Deferred.make<void>()
    yield* Effect.callback<void, Error>((resume) => {
      const session = http2Connect(`https://localhost:${port}`, { ca: certificate.cert })
      const request = session.request({ ":path": "/unfinished" })
      request.once("data", () => resume(Effect.void))
      request.on("error", () => undefined)
      session.on("error", () => undefined)
      session.on("close", () => Deferred.doneUnsafe(closed, Effect.void))
      return Effect.sync(() => session.destroy())
    })
    return Deferred.await(closed)
  })

/**
 * A websocket at `/socket` over a bare TCP connection that has read the `101` and then answers
 * nothing, so it never replies to a close frame as a browser does.
 */
const openMuteSocket = (port: number) =>
  Effect.gen(function*() {
    const closed = yield* Deferred.make<void>()
    yield* Effect.callback<void, Error>((resume) => {
      const socket = netConnect(port, "localhost")
      socket.once("data", () => resume(Effect.void))
      socket.on("error", () => undefined)
      socket.on("close", () => Deferred.doneUnsafe(closed, Effect.void))
      socket.write(
        `GET /socket HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
      )
      return Effect.sync(() => socket.destroy())
    })
    return Deferred.await(closed)
  })

describe("a stopping listener", () => {
  it.live("ends an open websocket on a plain listener", () =>
    Effect.gen(function*() {
      const { port, stop } = yield* serveUntilStopped(Option.none())
      const closed = yield* openSocket(`ws://localhost:${port}/socket`)

      const stopped = yield* Effect.timeoutOption(stop, STOP_BOUND)
      const seen = yield* Effect.timeoutOption(closed, STOP_BOUND)

      assert.isTrue(Option.isSome(stopped))
      assert.isTrue(Option.isSome(seen))
    }))

  it.live("ends a websocket whose client never answers the close frame", () =>
    Effect.gen(function*() {
      const { port, stop } = yield* serveUntilStopped(Option.none())
      const closed = yield* openMuteSocket(port)

      const stopped = yield* Effect.timeoutOption(stop, STOP_BOUND)
      const seen = yield* Effect.timeoutOption(closed, STOP_BOUND)

      assert.isTrue(Option.isSome(stopped))
      assert.isTrue(Option.isSome(seen))
    }))

  it.live("ends an open websocket on a TLS listener", () =>
    Effect.gen(function*() {
      const tls = Option.some(yield* tlsFiles)
      const { port, stop } = yield* serveUntilStopped(tls)
      const closed = yield* openSocket(`wss://localhost:${port}/socket`)

      const stopped = yield* Effect.timeoutOption(stop, STOP_BOUND)
      const seen = yield* Effect.timeoutOption(closed, STOP_BOUND)

      assert.isTrue(Option.isSome(stopped))
      assert.isTrue(Option.isSome(seen))
    }).pipe(Effect.scoped))

  it.live("ends a response that never finishes, over h2", () =>
    Effect.gen(function*() {
      const tls = Option.some(yield* tlsFiles)
      const { port, stop } = yield* serveUntilStopped(tls)
      const closed = yield* openStream(port)

      const stopped = yield* Effect.timeoutOption(stop, STOP_BOUND)
      const seen = yield* Effect.timeoutOption(closed, STOP_BOUND)

      assert.isTrue(Option.isSome(stopped))
      assert.isTrue(Option.isSome(seen))
    }).pipe(Effect.scoped))
})

/** The settings the environment `variables` give, resolved as the server resolves them. */
const resolved = (variables: Record<string, string>) =>
  TlsFilesConfig.parse(ConfigProvider.fromUnknown(variables)).pipe(Effect.flatMap(resolveTlsFiles))

describe("TLS settings from the environment", () => {
  it.effect("are both paths when both variables are set", () =>
    Effect.gen(function*() {
      const files = yield* resolved({ MUFW_TLS_CERT: "c.pem", MUFW_TLS_KEY: "k.pem" })

      assert.deepStrictEqual(files, Option.some({ cert: "c.pem", key: "k.pem" }))
    }))

  it.effect("are none when no variable is set", () =>
    Effect.gen(function*() {
      const files = yield* resolved({})

      assert.deepStrictEqual(files, Option.none())
    }))

  it.effect("refuse a certificate whose key variable is missing", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(resolved({ MUFW_TLS_CERT: "c.pem" }))

      assert.strictEqual(error._tag, "TlsConfigError")
    }))

  it.effect("refuse a key whose certificate variable is missing", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(resolved({ MUFW_TLS_KEY: "k.pem" }))

      assert.strictEqual(error._tag, "TlsConfigError")
    }))
})
