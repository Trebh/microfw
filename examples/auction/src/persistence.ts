import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { layerLoopLocal, layerLoopPersisted } from "@mufw/core"
import type { PlatformError } from "effect"
import { Effect, FileSystem, Layer, Option, Path } from "effect"
import type { Schema } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Auction } from "./domain/Auction.ts"
import { ServerPorts } from "./serverPorts.ts"

/** The store cannot be opened, or holds a model the auction cannot decode. */
export type AuctionStoreFailure =
  | KeyValueStore.KeyValueStoreError
  | PlatformError.PlatformError
  | Schema.SchemaError

/**
 * One file per key under `directory`, created on first use, as `KeyValueStore.layerFileSystem`
 * (same file names), except that `set` writes `<file>.tmp` and renames it onto the key's file. A
 * crash or an interrupted write leaves the previous content or the new one, never a truncated file;
 * `layerFileSystem` opens the file for writing in place, so an interruption leaves it empty.
 * No `fsync`: a process crash is covered, a power loss is not.
 */
export const layerAtomicFileStore = (directory: string) =>
  Layer.effect(
    KeyValueStore.KeyValueStore,
    Effect.gen(function*() {
      const inner = yield* KeyValueStore.KeyValueStore
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const set = (key: string, value: string | Uint8Array): Effect.Effect<void, KeyValueStore.KeyValueStoreError> => {
        if (key.length === 0 || key === "." || key === "..") {
          return Effect.fail(new KeyValueStore.KeyValueStoreError({ method: "set", key, message: `Invalid key ${key}` }))
        }
        const file = path.join(directory, encodeURIComponent(key))
        const temporary = `${file}.tmp`
        const write = typeof value === "string" ? fs.writeFileString(temporary, value) : fs.writeFile(temporary, value)
        return Effect.andThen(write, fs.rename(temporary, file)).pipe(
          Effect.mapError((cause) =>
            new KeyValueStore.KeyValueStoreError({
              method: "set",
              key,
              message: `Unable to set item with key ${key}`,
              cause
            })
          )
        )
      }
      return KeyValueStore.make({ ...inner, set })
    })
  ).pipe(Layer.provide(KeyValueStore.layerFileSystem(directory)))

const layerFileStore = (directory: string) =>
  layerAtomicFileStore(directory).pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))

const loopInMemory = layerLoopLocal(Auction, ServerPorts)

/** The server's loop layer, whatever it can fail with while it is built: what every way of running the loop provides and needs. */
export type AuctionLoop<E> = Layer.Layer<Layer.Success<typeof loopInMemory>, E, Layer.Services<typeof loopInMemory>>

const loopPersistedIn = (directory: string) =>
  layerLoopPersisted(Auction, ServerPorts).pipe(Layer.provide(layerFileStore(directory)))

/**
 * The server's loop: in memory, starting from `Auction.initial`, when no directory is configured;
 * else loaded from and persisted to a file-system store in that directory.
 */
export const layerAuctionLoop = (directory: Option.Option<string>): AuctionLoop<AuctionStoreFailure> =>
  Option.match(directory, { onNone: () => loopInMemory, onSome: loopPersistedIn })
