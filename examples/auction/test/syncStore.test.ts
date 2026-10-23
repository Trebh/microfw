import { NodeFileSystem } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { AutoActions, type SyncLogMismatch } from "@mufw/core"
import { Context, Deferred, Effect, Exit, FileSystem, Layer, Option, Schedule, Scope, Stream } from "effect"
import { layerCreditCheckTable } from "../src/adapters/creditCheckTable.ts"
import { Amount, Bidder } from "../src/domain/Values.ts"
import { ServerPorts } from "../src/serverPorts.ts"
import { layerAuctionSync } from "../src/sync.ts"

/** A host over the store directory `directory`, in a scope of its own that closing stops. */
const bootHost = (directory: string) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const stopped = yield* Deferred.make<never, SyncLogMismatch>()
    const { loop } = layerAuctionSync("host", {
      listen: { host: "127.0.0.1", port: 0 },
      store: Option.some(directory),
      stopped
    })
    const context = yield* Layer.build(
      loop.pipe(Layer.provide(layerCreditCheckTable), Layer.provide(Layer.succeed(AutoActions, false)))
    ).pipe(Scope.provide(scope))
    return {
      model: Context.get(context, ServerPorts.ModelPort),
      history: Context.get(context, ServerPorts.HistoryPort),
      stop: Scope.close(scope, Exit.void)
    }
  })

/** Waits, in real time, until the checkpoint file in `directory` says the model includes log sequence `sequence`. */
const awaitCheckpoint = (directory: string, sequence: number) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const text = yield* fileSystem.readFileString(`${directory}/auction`)
    const stored: { readonly sequence: number } = JSON.parse(text)
    if (stored.sequence !== sequence) return yield* Effect.fail("checkpoint not yet written")
  }).pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }))

describe("layerAuctionSync with a store", () => {
  it.live("keeps the host's log and model across a restart and replays no entry of the log", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped()
      const first = yield* bootHost(directory)
      yield* first.model.present({ _tag: "Opened", at: 1000 })
      yield* first.model.present({ _tag: "Bid", bidder: Bidder.make("alice"), amount: Amount.make(5), at: 2000 })
      yield* awaitCheckpoint(directory, 3)
      yield* first.stop

      const second = yield* bootHost(directory)

      const [initial] = yield* second.history.records.pipe(Stream.take(1), Stream.runCollect)
      const current = yield* second.model.representations.pipe(Stream.take(1), Stream.runCollect)
      assert.deepStrictEqual(initial?.model.bids.map((bid) => [bid.bidder, bid.amount]), [["alice", 5]])
      assert.deepStrictEqual(current[0]?.bids.map((bid) => [bid.bidder, bid.amount]), [["alice", 5]])
    }).pipe(Effect.provide(NodeFileSystem.layer), Effect.scoped))
})
