import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { AutoActions, layerLoopLocal } from "@mufw/core"
import { makeSsr } from "@mufw/view-uhtml/ssr"
import { Context, Deferred, Effect, Layer, Option, type Scope, Stream } from "effect"
import { HttpClient, HttpRouter } from "effect/http"
import { layerCreditCheckTable } from "../src/adapters/creditCheckTable.ts"
import { Auction, type Proposal, type Representation } from "../src/auction/Auction.ts"
import { Amount, Bidder } from "../src/domain/Values.ts"
import { samStreamPath } from "../src/samPath.ts"
import { ServerPorts } from "../src/serverPorts.ts"
import { chunks, layerStreamRoutes } from "../src/streamRoutes.ts"

const Loop = layerLoopLocal(Auction, ServerPorts).pipe(
  Layer.provide(layerCreditCheckTable),
  Layer.provide(Layer.succeed(AutoActions, false))
)

/** Completed when a subscription to the server's representations ends, however it ends. */
class Released extends Context.Service<Released, Deferred.Deferred<void>>()("test/Released") {}

const LayerReleased = Layer.effect(Released)(Deferred.make<void>())

/** The server's `ModelPort` as it is, except that every run of `representations` reports its end. */
const Watched = Layer.effect(ServerPorts.ModelPort)(
  Effect.gen(function*() {
    const model = yield* ServerPorts.ModelPort
    const released = yield* Released
    return {
      ...model,
      representations: model.representations.pipe(Stream.ensuring(Deferred.succeed(released, undefined)))
    }
  })
)

const Observed = Watched.pipe(Layer.provide(Loop), Layer.provideMerge(LayerReleased))

/** `serve` builds what it is given in a private memo map, so the port is provided from outside to be the one the test presents to. */
const Served = HttpRouter.serve(layerStreamRoutes, { disableListenLog: true }).pipe(
  Layer.provideMerge(Observed),
  Layer.provideMerge(NodeHttpServer.layerTest)
)

/**
 * Runs a test body against the served routes. Its scope ends before the server's does: the server
 * waits for open connections when it shuts down, and a stream never ends on its own.
 */
const onServer = <A, E>(body: Effect.Effect<A, E, Scope.Scope | Layer.Success<typeof Served>>) =>
  body.pipe(Effect.scoped, Effect.provide(Served))

const streamOfAuction = samStreamPath(Auction)

/** A connection to the stream that lives as long as the scope: its response, its first chunk, and `next` for each later one. */
const connect = (path: string) =>
  Effect.gen(function*() {
    const response = yield* HttpClient.get(path)
    const pull = yield* Stream.toPull(Stream.decodeText(response.stream))
    const next = Effect.map(pull, (parts) => parts.join(""))
    return { response, first: yield* next, next }
  })

const present = (proposal: Proposal) => ServerPorts.ModelPort.use((port) => port.present(proposal))

const OPENED: Proposal = { _tag: "Opened", at: 1000 }

/** An open auction whose only distinguishing mark is the rejection it shows. */
const viewRejecting = (reason: string): Representation => ({
  controlState: "open",
  item: "lamp",
  highest: Option.none(),
  bids: [],
  remainingSeconds: 60,
  minimumBid: Amount.make(10),
  lastRejection: Option.some(reason)
})

describe("GET /stream/<name>", () => {
  it.effect("answers 200 as an uncached html document", () =>
    onServer(Effect.gen(function*() {
      const { response } = yield* connect(streamOfAuction)

      assert.deepStrictEqual(
        [response.status, response.headers["content-type"], response.headers["cache-control"]],
        [200, "text/html; charset=utf-8", "no-store"]
      )
    })))

  it.effect("starts with the document, the current control state already in #app", () =>
    onServer(Effect.gen(function*() {
      const { first } = yield* connect(streamOfAuction)

      assert.include(first, "<div id=\"app\"><!--<>--><header>")
      assert.include(first, "<span class=\"badge opening\">opening</span>")
      assert.notInclude(first, "<template")
    })))

  it.effect("wraps #app in a disabled fieldset, so nothing on the page can bid", () =>
    onServer(Effect.gen(function*() {
      const { first } = yield* connect(streamOfAuction)

      assert.include(first, "<fieldset disabled><div id=\"app\">")
    })))

  it.effect("sends a presented proposal's view as a template and the call that swaps it into #app", () =>
    onServer(Effect.gen(function*() {
      const { next } = yield* connect(streamOfAuction)

      yield* present(OPENED)
      const second = yield* next

      assert.isTrue(second.startsWith("<template id=\"mufw-next\"><!--<>--><header>"))
      assert.include(second, "<span class=\"badge open\">open</span>")
      assert.isTrue(second.endsWith("</template><script>mufwReplace()\n</script>"))
    })))

  it.effect("sends the document once: an update does not carry it again", () =>
    onServer(Effect.gen(function*() {
      const { next } = yield* connect(streamOfAuction)

      yield* present(OPENED)
      const second = yield* next

      assert.notInclude(second, "<!doctype html>")
    })))

  it.effect("gives a reader that fell behind the latest view, not every one in between", () =>
    Effect.gen(function*() {
      const opened = yield* Deferred.make<void>()
      const published = yield* Deferred.make<void>()
      const views = Stream.make(viewRejecting("first")).pipe(
        Stream.concat(Stream.fromEffectDrain(Deferred.await(opened))),
        Stream.concat(Stream.make(viewRejecting("stale-a"), viewRejecting("stale-b"), viewRejecting("latest"))),
        Stream.concat(Stream.fromEffectDrain(Deferred.succeed(published, undefined)))
      )
      const readerStalledOnFirst = Effect.andThen(Deferred.succeed(opened, undefined), Deferred.await(published))

      const received = yield* chunks(makeSsr(), views).pipe(
        Stream.decodeText,
        Stream.tap(() => readerStalledOnFirst),
        Stream.runCollect
      )

      assert.deepStrictEqual(
        received.map((chunk) => [chunk.includes("first"), chunk.includes("latest"), chunk.includes("stale")]),
        [[true, false, false], [false, true, false]]
      )
    }))

  it.effect("escapes the text of a representation, so it cannot end its template", () =>
    onServer(Effect.gen(function*() {
      const { next } = yield* connect(streamOfAuction)
      yield* present(OPENED)
      yield* next

      yield* present({ _tag: "BidRejected", bidder: Bidder.make("alice"), reason: "</template><script>x</script>" })
      const third = yield* next

      assert.include(third, "&lt;/template&gt;&lt;script&gt;x&lt;/script&gt;")
      assert.notInclude(third, "</template><script>x")
    })))

  it.effect("answers 404 for a name that no served definition has", () =>
    onServer(Effect.gen(function*() {
      const response = yield* HttpClient.get("/stream/wallet")

      assert.deepStrictEqual([response.status, yield* response.text], [404, "Not Found"])
    })))

  it.effect("keeps its subscription while the client is connected and releases it when the client leaves", () =>
    onServer(Effect.gen(function*() {
      const released = yield* Released

      const releasedWhileConnected = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* connect(streamOfAuction)
          return yield* Deferred.isDone(released)
        })
      )
      yield* Deferred.await(released)

      assert.isFalse(releasedWhileConnected)
    })))
})
