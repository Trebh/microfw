import { BrowserWorker, BrowserWorkerRunner } from "@effect/platform-browser"
import { assert, describe, it } from "@effect/vitest"
import { AutoActions } from "@mufw/core"
import { Cause, Deferred, Effect, Layer, Option, Stream } from "effect"
import { Connection, type ConnectionState } from "../src/client/connection.ts"
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
 * The worker's own composition on the worker end of a message channel. It is built afresh because
 * layers are memoised by reference within a fiber, so a second host would otherwise reuse the first
 * one's, still bound to the first channel.
 */
const hostOn = (messages: MessageChannel) =>
  Layer.fresh(workerHost).pipe(
    Layer.provide(BrowserWorkerRunner.layerMessagePort(messages.port1)),
    Layer.provide(noAutoActions)
  )

/**
 * The worker's own composition on one end of a message channel and the page's remote ports on the
 * other, so a request crosses the real worker protocols: initial message, encoding, structured clone.
 */
const workerFor = (bidder: Bidder) =>
  Layer.unwrap(
    Effect.map(channel, (messages) => {
      const page = workerPorts(bidder).pipe(Layer.provide(BrowserWorker.layer(() => messages.port2)))
      return Layer.merge(page, hostOn(messages))
    })
  )

/**
 * A page whose spawner hands out the page ends of `channels` in order, one per spawn, so the worker
 * it respawns after a failure is the next channel's.
 */
const pageOver = (bidder: Bidder, channels: ReadonlyArray<MessageChannel>) => {
  const ports = channels.map((messages) => messages.port2)
  return workerPorts(bidder).pipe(Layer.provide(BrowserWorker.layer(() => ports.shift()!)))
}

/** What a worker's `error` event is to the page: the signal the platform turns into a failed `run`. */
const crash = (messages: MessageChannel) => Effect.sync(() => messages.port2.dispatchEvent(new Event("error")))

const reaches = (state: ConnectionState) =>
  Connection.useSync((states) => states).pipe(
    Effect.flatMap((states) => states.pipe(Stream.filter((current) => current === state), Stream.runHead))
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

describe("the worker page's connection", () => {
  it.live("is connecting while no worker has said it is ready", () =>
    Effect.gen(function*() {
      const unserved = yield* channel

      const state = yield* Connection.useSync((states) => states).pipe(
        Effect.flatMap(Stream.runHead),
        Effect.provide(pageOver(Bidder.make("alice"), [unserved]))
      )

      assert.deepStrictEqual(state, Option.some("connecting"))
    }).pipe(Effect.timeout("5 seconds")))

  it.live("is connected once the worker is ready", () =>
    Effect.gen(function*() {
      const served = yield* channel

      const state = yield* reaches("connected").pipe(
        Effect.provide(Layer.merge(pageOver(Bidder.make("alice"), [served]), hostOn(served)))
      )

      assert.deepStrictEqual(state, Option.some("connected"))
    }).pipe(Effect.timeout("5 seconds")))

  it.live("is disconnected when the worker raises an error event", () =>
    Effect.gen(function*() {
      const doomed = yield* channel

      const state = yield* Effect.gen(function*() {
        yield* reaches("connected")
        yield* crash(doomed)
        return yield* reaches("disconnected")
      }).pipe(Effect.provide(Layer.merge(pageOver(Bidder.make("alice"), [doomed]), hostOn(doomed))))

      assert.deepStrictEqual(state, Option.some("disconnected"))
    }).pipe(Effect.timeout("5 seconds")))

  it.live("is connected again once a respawned worker is ready", () =>
    Effect.gen(function*() {
      const doomed = yield* channel
      const replacement = yield* channel
      const firstWorker = Layer.merge(pageOver(Bidder.make("alice"), [doomed, replacement]), hostOn(doomed))

      const state = yield* Effect.gen(function*() {
        yield* reaches("connected")
        yield* crash(doomed)
        yield* reaches("disconnected")
        yield* Effect.forkScoped(Layer.launch(hostOn(replacement)))
        return yield* reaches("connected")
      }).pipe(Effect.provide(firstWorker), Effect.scoped)

      assert.deepStrictEqual(state, Option.some("connected"))
    }).pipe(Effect.timeout("10 seconds")))

  it.live("is disconnected when the worker cannot be spawned", () =>
    Effect.gen(function*() {
      const unspawnable = workerPorts(Bidder.make("alice")).pipe(
        Layer.provide(BrowserWorker.layer(() => {
          throw new Error("worker blocked")
        }))
      )

      const state = yield* reaches("disconnected").pipe(Effect.provide(unspawnable))

      assert.deepStrictEqual(state, Option.some("disconnected"))
    }).pipe(Effect.timeout("5 seconds")))
})
