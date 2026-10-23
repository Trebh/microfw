import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Option } from "effect"
import { createServer } from "node:net"
import { type AuctionSyncOptions, checkSyncSettings, layerAuctionSync } from "../src/sync.ts"

const host = Option.some("host" as const)
const joiner = Option.some("ws://127.0.0.1:3101/eventlog" as const)
const ports = { port: 3001, syncPort: 3101 }

describe("checkSyncSettings", () => {
  it.effect("refuses TravelTo with a log: it would move one instance's model away from the log's", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(checkSyncSettings({ sync: joiner, rpcs: ["Submit", "TravelTo"], ...ports }))

      assert.strictEqual(error._tag, "SyncConfigError")
    }))

  it.effect("refuses Replay with a log: it would apply proposals the log does not hold", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(checkSyncSettings({ sync: joiner, rpcs: ["Submit", "Replay"], ...ports }))

      assert.strictEqual(error.message, "MUFW_SYNC does not serve Replay: it would move this instance's model away from the log's; remove it from MUFW_RPCS")
    }))

  it.effect("refuses a host whose event log would share the public port", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(checkSyncSettings({ sync: host, rpcs: ["Submit"], port: 3001, syncPort: 3001 }))

      assert.strictEqual(error.message, "MUFW_SYNC_PORT must differ from MUFW_PORT: the event log is served on its own port, never the public one")
    }))

  it.effect("accepts equal ports on an instance that joins: it serves no log", () =>
    Effect.gen(function*() {
      yield* checkSyncSettings({ sync: joiner, rpcs: ["Submit"], port: 3001, syncPort: 3001 })
    }))

  it.effect("accepts a log with the server-owned RPCs", () =>
    Effect.gen(function*() {
      yield* checkSyncSettings({ sync: host, rpcs: ["Submit", "Representations", "History"], ...ports })
    }))

  it.effect("accepts TravelTo when there is no log", () =>
    Effect.gen(function*() {
      yield* checkSyncSettings({ sync: Option.none(), rpcs: ["TravelTo"], ...ports })
    }))
})

/** A TCP server on a free loopback port, held until the test's scope closes: the port a listener would want. */
const occupiedPort = Effect.acquireRelease(
  Effect.callback<{ readonly port: number; readonly close: () => void }>((resume) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      resume(Effect.succeed({ port, close: () => void server.close() }))
    })
  }),
  ({ close }) => Effect.sync(close)
)

/** The options of a synced instance with no store, listening on `port`. */
const options = (port: number): AuctionSyncOptions => ({
  listen: { host: "127.0.0.1", port },
  store: Option.none(),
  stopped: Deferred.makeUnsafe()
})

describe("layerAuctionSync event-log listener", () => {
  it.effect("opens no listener on an instance that joins", () =>
    Effect.gen(function*() {
      const { port } = yield* occupiedPort

      yield* Layer.build(layerAuctionSync("ws://127.0.0.1:3101/eventlog", options(port)).eventLog)
    }))

  it.effect("opens its listener on the host, which fails when the port is taken", () =>
    Effect.gen(function*() {
      const { port } = yield* occupiedPort

      const error = yield* Effect.flip(Layer.build(layerAuctionSync("host", options(port)).eventLog))

      assert.strictEqual(error._tag, "ServeError")
    }))
})
