import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { AutoActions, layerLoopLocal, type ModelPort } from "@mufw/core"
import type { SamClient } from "@mufw/rpc"
import { Context, Effect, Exit, Layer, Option, Queue, Ref, Stream } from "effect"
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  type HttpClientResponse,
  HttpRouter
} from "effect/http"
import { layerCreditCheckTable } from "../src/adapters/creditCheckTable.ts"
import { layerClientOverHttp, layerModelOverHttp } from "../src/client/placements/httpReadOnly.ts"
import { Auction, type Representation } from "../src/domain/Auction.ts"
import { Amount, Bidder } from "../src/domain/Values.ts"
import { layerHttpRoutes, layerLatestRepresentations } from "../src/httpRoutes.ts"
import { Ports, Rpc } from "../src/ports.ts"
import { samHttpPath } from "../src/samPath.ts"
import { ServerPorts } from "../src/serverPorts.ts"

const path = samHttpPath(Auction)

const Loop = layerLoopLocal(Auction, ServerPorts).pipe(
  Layer.provide(layerCreditCheckTable),
  Layer.provide(Layer.succeed(AutoActions, false))
)

/**
 * The HTTP routes over a real HTTP server on a free port, over a `Loop` the test also reaches. The
 * `HttpClient` in context targets that server: it prefixes the origin to every request path. The
 * server stops when `Effect.provide(Served)` ends and waits for its open connections, so a test
 * that holds a stream open closes the client's scope first, with `Effect.scoped` inside the provide.
 */
const Served = HttpRouter.serve(layerHttpRoutes, { disableListenLog: true }).pipe(
  Layer.provideMerge(Loop),
  Layer.provideMerge(NodeHttpServer.layerTest)
)

/** The full address of the endpoint: the test client shows the origin it prefixed in the request of a response. */
const endpoint = HttpClient.get("/").pipe(Effect.map((response) => `${new URL(response.request.url).origin}${path}`))

type Summary = readonly [controlState: string, highest: string]

const summary = (representation: Representation): Summary => [
  representation.controlState,
  Option.match(representation.highest, { onNone: () => "no bids", onSome: (bid) => `${bid.bidder} ${bid.amount}` })
]

/**
 * Every representation that the client of `layer` receives, as `summary`, in a queue the test takes
 * from. The client's ports are keyed like the server's loop, so `layer` is built apart, into the
 * test's scope, and read from a context of its own.
 */
const watching = (layer: Layer.Layer<ModelPort<typeof Auction>>) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(layer)
    const model = Context.get(context, Ports.ModelPort)
    const seen = yield* Queue.unbounded<Summary>()
    yield* Stream.runForEach(model.representations, (representation) => Queue.offer(seen, summary(representation))).pipe(
      Effect.forkScoped
    )
    return seen
  })

/** Whether the call, made over HTTP by the client of the real endpoint, died: the server has no route for it. */
const dies = <A, E>(call: (client: SamClient<typeof Auction>) => Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const url = yield* endpoint
    const context = yield* Layer.build(layerClientOverHttp(url).pipe(Layer.provide(FetchHttpClient.layer)))
    return yield* call(Context.get(context, Rpc.Client)).pipe(Effect.exit, Effect.map(Exit.hasDies))
  }).pipe(Effect.scoped)

const REPRESENTATIONS_REQUEST =
  "{\"_tag\":\"Request\",\"id\":\"1\",\"tag\":\"Representations\",\"payload\":null,\"headers\":[]}\n"

const postRepresentations = HttpClient.post(path, { body: HttpBody.text(REPRESENTATIONS_REQUEST, "application/ndjson") })

/** The first line of the response; reading it only as far as that closes the connection, which the server's stop waits for. */
const firstLineOf = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(Stream.decodeText, Stream.splitLines, Stream.runHead)

const unreachable = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description: "connection refused" })
  })

/** The `HttpClient` in context, except that its first request fails as if the server were unreachable. */
const failFirstRequest = Layer.effect(HttpClient.HttpClient)(
  Effect.gen(function*() {
    const real = yield* HttpClient.HttpClient
    const requests = yield* Ref.make(0)
    return HttpClient.transform(real, (response, request) =>
      Ref.getAndUpdate(requests, (n) => n + 1).pipe(
        Effect.flatMap((n) => n === 0 ? Effect.fail(unreachable(request)) : response)
      ))
  })
)

describe("representations over HTTP", () => {
  it.live("reach layerModelRemote one by one, as the server's loop produces them", () =>
    Effect.gen(function*() {
      const server = yield* ServerPorts.ModelPort
      const url = yield* endpoint
      const seen = yield* watching(layerModelOverHttp(url).pipe(Layer.provide(FetchHttpClient.layer)))

      const first = yield* Queue.take(seen)
      yield* server.present({ _tag: "Opened", at: 1000 })
      const second = yield* Queue.take(seen)
      yield* server.present({ _tag: "Bid", bidder: Bidder.make("alice"), amount: Amount.make(10), at: 2000 })
      const third = yield* Queue.take(seen)

      assert.deepStrictEqual(
        [first, second, third],
        [["opening", "no bids"], ["open", "no bids"], ["open", "alice 10"]]
      )
    }).pipe(Effect.scoped, Effect.provide(Served)))

  it.live("are requested again after a request that never reached the server", () =>
    Effect.gen(function*() {
      const url = yield* endpoint
      const seen = yield* watching(
        layerModelOverHttp(url).pipe(Layer.provide(failFirstRequest), Layer.provide(FetchHttpClient.layer))
      )

      const first = yield* Queue.take(seen)

      assert.deepStrictEqual(first, ["opening", "no bids"])
    }).pipe(Effect.scoped, Effect.provide(Served)))
})

describe("the representations the HTTP routes serve", () => {
  it.effect("skip to the latest for a reader that stopped after the first", () =>
    Effect.gen(function*() {
      const server = yield* ServerPorts.ModelPort
      const served = Context.get(yield* Layer.build(layerLatestRepresentations), ServerPorts.ModelPort)
      const pull = yield* Stream.toPull(served.representations)
      const first = yield* pull

      yield* server.present({ _tag: "Opened", at: 1000 })
      yield* server.present({ _tag: "Bid", bidder: Bidder.make("alice"), amount: Amount.make(10), at: 2000 })
      yield* server.present({ _tag: "Bid", bidder: Bidder.make("bob"), amount: Amount.make(20), at: 3000 })
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 50 }))
      const resumed = yield* pull

      assert.deepStrictEqual(
        [summary(first[0]!), summary(resumed[0]!)],
        [["opening", "no bids"], ["open", "bob 20"]]
      )
    }).pipe(Effect.scoped, Effect.provide(Loop)))
})

describe("the HTTP endpoint", () => {
  it.effect("answers a POST with the NDJSON line of the current representation", () =>
    Effect.gen(function*() {
      const response = yield* postRepresentations

      const firstLine = yield* firstLineOf(response)

      assert.isTrue(Option.exists(firstLine, (line) => line.startsWith("{\"_tag\":\"Chunk\",\"requestId\":\"1\"")))
      assert.isTrue(Option.exists(firstLine, (line) => line.includes("\"controlState\":\"opening\"")))
    }).pipe(Effect.provide(Served)))

  it.effect("answers a POST with the NDJSON content type, open to any origin", () =>
    Effect.gen(function*() {
      const response = yield* postRepresentations
      yield* firstLineOf(response)

      assert.deepStrictEqual(
        [response.headers["content-type"], response.headers["access-control-allow-origin"]],
        ["application/ndjson", "*"]
      )
    }).pipe(Effect.provide(Served)))

  it.effect("answers a preflight for a POST from any origin", () =>
    Effect.gen(function*() {
      const response = yield* HttpClient.options(path)

      assert.deepStrictEqual(
        [response.status, response.headers["access-control-allow-origin"], response.headers["access-control-allow-methods"]],
        [204, "*", "POST"]
      )
    }).pipe(Effect.provide(Served)))

  it.effect("does not route Present, and the server's model does not move", () =>
    Effect.gen(function*() {
      const refused = yield* dies((client) => client.Present({ _tag: "Opened", at: 1000 }))

      const current = yield* ServerPorts.ModelPort.use((model) => Stream.runHead(model.representations))

      assert.isTrue(refused)
      assert.deepStrictEqual(Option.map(current, (representation) => representation.controlState), Option.some("opening"))
    }).pipe(Effect.provide(Served)))

  it.effect("does not route Submit", () =>
    Effect.gen(function*() {
      assert.isTrue(yield* dies((client) => client.Submit({ _tag: "Open" })))
    }).pipe(Effect.provide(Served)))

  it.effect("does not route Dispatch", () =>
    Effect.gen(function*() {
      assert.isTrue(yield* dies((client) => client.Dispatch({ _tag: "Open" })))
    }).pipe(Effect.provide(Served)))

  it.effect("does not route History", () =>
    Effect.gen(function*() {
      assert.isTrue(yield* dies((client) => Stream.runHead(client.History())))
    }).pipe(Effect.provide(Served)))

  it.effect("does not route TravelTo", () =>
    Effect.gen(function*() {
      assert.isTrue(yield* dies((client) => client.TravelTo({ seq: 0 })))
    }).pipe(Effect.provide(Served)))
})
