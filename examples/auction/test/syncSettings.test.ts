import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Deferred, Effect, Layer, Option } from "effect"
import { createServer } from "node:net"
import { type AuctionSyncOptions, checkSyncSettings, layerAuctionSync, SyncCutEvery } from "../src/sync.ts"

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

/** What `SyncCutEvery` reads when the environment holds exactly `env`. */
const cutEveryOf = (env: Record<string, string>) =>
  SyncCutEvery.parse(ConfigProvider.fromEnv({ env }))

describe("SyncCutEvery", () => {
  it.effect("is 1000 when MUFW_SYNC_CUT_EVERY is unset", () =>
    Effect.gen(function*() {
      const every = yield* cutEveryOf({})

      assert.strictEqual(every, 1000)
    }))

  it.effect("reads MUFW_SYNC_CUT_EVERY as a whole number", () =>
    Effect.gen(function*() {
      const every = yield* cutEveryOf({ MUFW_SYNC_CUT_EVERY: "4" })

      assert.strictEqual(every, 4)
    }))

  it.effect("refuses 0: the log would be cut at every entry it has not yet applied", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(cutEveryOf({ MUFW_SYNC_CUT_EVERY: "0" }))

      assert.match(error.message, /greater than or equal to 1/)
    }))

  it.effect("refuses a number with a fraction", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(cutEveryOf({ MUFW_SYNC_CUT_EVERY: "2.5" }))

      assert.match(error.message, /integer/)
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
  stopped: Deferred.makeUnsafe(),
  cutEvery: 1000
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
