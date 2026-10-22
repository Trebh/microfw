import { NodePath } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, PlatformError } from "effect"
import { KeyValueStore } from "effect/persistence"
import { layerAtomicFileStore } from "../src/persistence.ts"

type Rename = FileSystem.FileSystem["rename"]

const systemFailure = (method: string, path: string) =>
  PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method, pathOrDescriptor: path })

/** A directory that exists and whose files live in `files`; `rename` is the only operation a test varies. */
const memoryFileSystem = (files: Map<string, string>, rename: Rename) =>
  FileSystem.layerNoop({
    exists: () => Effect.succeed(true),
    readFileString: (path) => {
      const text = files.get(path)
      return text === undefined ? Effect.fail(systemFailure("readFileString", path)) : Effect.succeed(text)
    },
    writeFileString: (path, data) =>
      Effect.sync(() => {
        files.set(path, data)
      }),
    rename
  })

const moveFile = (files: Map<string, string>): Rename => (from, to) =>
  Effect.sync(() => {
    files.set(to, files.get(from) ?? "")
    files.delete(from)
  })

const failToRename: Rename = (from) => Effect.fail(systemFailure("rename", from))

const storeOver = (files: Map<string, string>, rename: Rename) =>
  layerAtomicFileStore("/store").pipe(Layer.provide(Layer.merge(memoryFileSystem(files, rename), NodePath.layer)))

const stored = KeyValueStore.KeyValueStore

describe("layerAtomicFileStore", () => {
  it.effect("keeps the previous content when the rename of a set fails", () => {
    const files = new Map([["/store/auction", "old"]])
    return Effect.gen(function*() {
      const store = yield* stored

      const failure = yield* Effect.flip(store.set("auction", "new"))

      assert.deepStrictEqual(
        [failure._tag, yield* store.get("auction")],
        ["KeyValueStoreError", "old"]
      )
    }).pipe(Effect.provide(storeOver(files, failToRename)))
  })

  it.effect("replaces the content of the key's file and leaves no temporary file", () => {
    const files = new Map([["/store/auction", "old"]])
    return Effect.gen(function*() {
      const store = yield* stored

      yield* store.set("auction", "new")

      assert.deepStrictEqual(Array.from(files), [["/store/auction", "new"]])
    }).pipe(Effect.provide(storeOver(files, moveFile(files))))
  })

  it.effect("reads back what it wrote", () => {
    const files = new Map<string, string>()
    return Effect.gen(function*() {
      const store = yield* stored
      yield* store.set("auction", "{\"item\":1}")

      const text = yield* store.get("auction")

      assert.strictEqual(text, "{\"item\":1}")
    }).pipe(Effect.provide(storeOver(files, moveFile(files))))
  })

  it.effect("rejects a key that names the directory and writes nothing", () => {
    const files = new Map<string, string>()
    return Effect.gen(function*() {
      const store = yield* stored

      const failure = yield* Effect.flip(store.set("..", "x"))

      assert.deepStrictEqual([failure._tag, failure.message, files.size], [
        "KeyValueStoreError",
        "Invalid key ..",
        0
      ])
    }).pipe(Effect.provide(storeOver(files, moveFile(files))))
  })
})
