import { NodePath } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, PlatformError } from "effect"
import { KeyValueStore } from "effect/persistence"
import { layerAtomicFileStore } from "../src/persistence.ts"

type Operations = Partial<FileSystem.FileSystem>

const systemFailure = (method: string, path: string, tag: PlatformError.SystemErrorTag = "NotFound") =>
  PlatformError.systemError({ _tag: tag, module: "FileSystem", method, pathOrDescriptor: path })

const unsupported = Effect.die("not used by the store")

/** An open handle on `path`: writes land in `files`, every write and sync is appended to `log`. */
const fakeFile = (
  files: Map<string, string>,
  log: Array<string>,
  path: string,
  sync: Effect.Effect<void, PlatformError.PlatformError> = Effect.void
): FileSystem.File => ({
  [FileSystem.FileTypeId]: FileSystem.FileTypeId,
  stat: unsupported,
  seek: () => unsupported,
  read: () => unsupported,
  readAlloc: () => unsupported,
  truncate: () => unsupported,
  write: () => unsupported,
  writeAll: (buffer) =>
    Effect.sync(() => {
      log.push(`write ${path}`)
      files.set(path, `${files.get(path) ?? ""}${new TextDecoder().decode(buffer)}`)
    }),
  sync: Effect.andThen(
    Effect.sync(() => {
      log.push(`sync ${path}`)
    }),
    sync
  )
})

/** A directory `/store` that exists and whose files live in `files`; `log` records the order of operations. */
const memoryFileSystem = (files: Map<string, string>, log: Array<string>): Operations => ({
  exists: () => Effect.succeed(true),
  readFileString: (path) => {
    const text = files.get(path)
    return text === undefined ? Effect.fail(systemFailure("readFileString", path)) : Effect.succeed(text)
  },
  open: (path, options) =>
    Effect.sync(() => {
      if (options?.flag === "w") {
        files.set(path, "")
      }
      return fakeFile(files, log, path)
    }),
  rename: (from, to) =>
    Effect.sync(() => {
      log.push(`rename ${from} ${to}`)
      files.set(to, files.get(from) ?? "")
      files.delete(from)
    })
})

const storeOver = (files: Map<string, string>, log: Array<string>, overrides: Operations = {}) =>
  layerAtomicFileStore("/store").pipe(
    Layer.provide(
      Layer.merge(FileSystem.layerNoop({ ...memoryFileSystem(files, log), ...overrides }), NodePath.layer)
    )
  )

const stored = KeyValueStore.KeyValueStore

describe("layerAtomicFileStore", () => {
  it.effect("writes the temporary file, syncs it, renames it, syncs the directory, in that order", () => {
    const files = new Map<string, string>()
    const log: Array<string> = []
    return Effect.gen(function*() {
      const store = yield* stored

      yield* store.set("auction", "new")

      assert.deepStrictEqual(log, [
        "write /store/auction.tmp",
        "sync /store/auction.tmp",
        "rename /store/auction.tmp /store/auction",
        "sync /store"
      ])
    }).pipe(Effect.provide(storeOver(files, log)))
  })

  it.effect("writes the bytes of a binary value", () => {
    const files = new Map<string, string>()
    return Effect.gen(function*() {
      const store = yield* stored

      yield* store.set("auction", new Uint8Array([104, 105]))

      assert.deepStrictEqual(Array.from(files), [["/store/auction", "hi"]])
    }).pipe(Effect.provide(storeOver(files, [])))
  })

  it.effect("keeps the previous content and does not rename when syncing the temporary file fails", () => {
    const files = new Map([["/store/auction", "old"]])
    const log: Array<string> = []
    const failingSync = Effect.fail(systemFailure("sync", "/store/auction.tmp", "Unknown"))
    return Effect.gen(function*() {
      const store = yield* stored

      const failure = yield* Effect.flip(store.set("auction", "new"))

      assert.deepStrictEqual(
        [failure._tag, yield* store.get("auction"), log.includes("rename /store/auction.tmp /store/auction")],
        ["KeyValueStoreError", "old", false]
      )
    }).pipe(Effect.provide(storeOver(files, log, {
      open: (path) =>
        Effect.sync(() => {
          files.set(path, "")
          return fakeFile(files, log, path, failingSync)
        })
    })))
  })

  it.effect("fails the set when syncing the directory fails", () => {
    const files = new Map<string, string>()
    const log: Array<string> = []
    const base = FileSystem.makeNoop(memoryFileSystem(files, log))
    return Effect.gen(function*() {
      const store = yield* stored

      const failure = yield* Effect.flip(store.set("auction", "new"))

      assert.deepStrictEqual(failure._tag, "KeyValueStoreError")
    }).pipe(Effect.provide(storeOver(files, log, {
      open: (path, options) =>
        path === "/store"
          ? Effect.succeed(fakeFile(files, log, path, Effect.fail(systemFailure("sync", path, "Unknown"))))
          : base.open(path, options)
    })))
  })

  it.effect("reports success when the platform cannot open a directory", () => {
    const files = new Map<string, string>()
    const log: Array<string> = []
    const base = FileSystem.makeNoop(memoryFileSystem(files, log))
    return Effect.gen(function*() {
      const store = yield* stored

      yield* store.set("auction", "new")

      assert.deepStrictEqual(Array.from(files), [["/store/auction", "new"]])
    }).pipe(Effect.provide(storeOver(files, log, {
      open: (path, options) =>
        path === "/store" ? Effect.fail(systemFailure("open", path, "BadResource")) : base.open(path, options)
    })))
  })

  it.effect("keeps the previous content when the rename of a set fails", () => {
    const files = new Map([["/store/auction", "old"]])
    return Effect.gen(function*() {
      const store = yield* stored

      const failure = yield* Effect.flip(store.set("auction", "new"))

      assert.deepStrictEqual(
        [failure._tag, yield* store.get("auction")],
        ["KeyValueStoreError", "old"]
      )
    }).pipe(Effect.provide(storeOver(files, [], { rename: (from) => Effect.fail(systemFailure("rename", from)) })))
  })

  it.effect("replaces the content of the key's file and leaves no temporary file", () => {
    const files = new Map([["/store/auction", "old"]])
    return Effect.gen(function*() {
      const store = yield* stored

      yield* store.set("auction", "new")

      assert.deepStrictEqual(Array.from(files), [["/store/auction", "new"]])
    }).pipe(Effect.provide(storeOver(files, [])))
  })

  it.effect("reads back what it wrote", () => {
    const files = new Map<string, string>()
    return Effect.gen(function*() {
      const store = yield* stored
      yield* store.set("auction", "{\"item\":1}")

      const text = yield* store.get("auction")

      assert.strictEqual(text, "{\"item\":1}")
    }).pipe(Effect.provide(storeOver(files, [])))
  })

  it.effect("rejects a key that names the directory and writes nothing", () => {
    const files = new Map<string, string>()
    const log: Array<string> = []
    return Effect.gen(function*() {
      const store = yield* stored

      const failure = yield* Effect.flip(store.set("..", "x"))

      assert.deepStrictEqual([failure._tag, failure.message, files.size, log], [
        "KeyValueStoreError",
        "Invalid key ..",
        0,
        []
      ])
    }).pipe(Effect.provide(storeOver(files, log)))
  })
})
