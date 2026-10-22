import { BrowserWorker, BrowserWorkerRunner } from "@effect/platform-browser"
import { assert, describe, it } from "@effect/vitest"
import { AutoActions } from "@mufw/core"
import { Cause, Deferred, Effect, Layer, Option, Stream } from "effect"
import { workerPorts } from "../src/client/placements/worker.ts"
import { workerHost } from "../src/client/placements/workerHost.ts"
import type { Representation } from "../src/domain/Auction.ts"
import { Amount, Bidder } from "../src/domain/Values.ts"
import { Ports, Rpc } from "../src/ports.ts"
import { auctionModel as model, clockedIntentDriver, named } from "./drivers.ts"

/** What the page and the worker each hold of one message channel: the structured-clone boundary of a real worker. */
const channel = Effect.sync(() => new MessageChannel())

const noAutoActions = Layer.succeed(AutoActions, false)

/**
 * The worker's own composition on one end of a message channel and the page's remote ports on the
 * other, so a request crosses the real worker protocols: initial message, encoding, structured clone.
 */
const workerFor = (bidder: Bidder) =>
  Layer.unwrap(
    Effect.map(channel, (messages) => {
      const host = workerHost.pipe(
        Layer.provide(BrowserWorkerRunner.layerMessagePort(messages.port1)),
        Layer.provide(noAutoActions)
      )
      const page = workerPorts(bidder).pipe(Layer.provide(BrowserWorker.layer(() => messages.port2)))
      return Layer.merge(page, host)
    })
  )

const awaitRepresentation = (predicate: (representation: Representation) => boolean) =>
  Ports.ModelPort.use((port) => port.representations.pipe(Stream.filter(predicate), Stream.runHead)).pipe(
    Effect.map(Option.getOrThrow)
  )

describe("the auction in a worker", () => {
  it.effect.each(named(model.shortestPaths))("reaches every state over the worker's protocol: $name", ({ path }) =>
    model.run(path, clockedIntentDriver).pipe(Effect.provide(workerFor(Bidder.make("alice")))))

  it.live("a bid is the bidder the page named when it started the worker", () =>
    Effect.gen(function*() {
      const intents = yield* Ports.IntentPort
      yield* intents.dispatch({ _tag: "Open" })
      yield* awaitRepresentation((representation) => representation.controlState === "open")

      yield* intents.dispatch({ _tag: "PlaceBid", amount: Amount.make(5) })
      const bid = yield* awaitRepresentation((representation) => Option.isSome(representation.highest))

      assert.deepStrictEqual(Option.map(bid.highest, (highest) => highest.bidder), Option.some(Bidder.make("carol")))
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(workerFor(Bidder.make("carol")))))

  it.live("a proposal cannot be presented to the model: the worker does not route Present", () =>
    Effect.gen(function*() {
      const outcome = yield* Rpc.Client.use((client) => client.Present({ _tag: "Opened", at: 0 })).pipe(
        Effect.matchCause({ onFailure: Cause.pretty, onSuccess: () => "presented" })
      )

      assert.include(outcome, "Unknown request tag: Present")
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(workerFor(Bidder.make("alice")))))

  it.live("a stream that stays open does not hold back another call", () =>
    Effect.gen(function*() {
      const streaming = yield* Deferred.make<void>()
      const port = yield* Ports.ModelPort
      yield* port.representations.pipe(
        Stream.tap(() => Deferred.succeed(streaming, undefined)),
        Stream.runDrain,
        Effect.forkScoped
      )
      yield* Deferred.await(streaming)

      const record = yield* Ports.HistoryPort.use((history) => Stream.runHead(history.records))

      assert.strictEqual(Option.getOrThrow(record).seq, 0)
    }).pipe(Effect.scoped, Effect.timeout("5 seconds"), Effect.provide(workerFor(Bidder.make("alice")))))

  it.live("a worker started with an initial message that names no bidder serves nothing", () =>
    Effect.gen(function*() {
      const messages = yield* channel
      messages.port2.postMessage([0, { _tag: "InitialMessage", value: { bidder: "" } }])
      const host = workerHost.pipe(Layer.provide(BrowserWorkerRunner.layerMessagePort(messages.port1)))

      const failure = yield* Layer.build(host).pipe(Effect.scoped, Effect.flip)

      assert.strictEqual(failure._tag, "SchemaError")
    }).pipe(Effect.timeout("5 seconds")))
})
