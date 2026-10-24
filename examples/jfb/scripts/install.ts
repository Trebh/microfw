import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { cp, rm, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { ENTRIES, JfbFailure, OUT_KEYED } from "./entries.ts"

const failure = (message: string) => (error: unknown) => new JfbFailure({ message: `${message}: ${String(error)}` })

const requireDirectory = (path: string, hint: string) =>
  Effect.tryPromise({ try: () => stat(path), catch: failure(`${path} does not exist; ${hint}`) }).pipe(
    Effect.filterOrFail((info) => info.isDirectory(), () => new JfbFailure({ message: `${path} is not a directory` }))
  )

const checkoutFrom = (argv: ReadonlyArray<string>) => {
  const checkout = argv[2]
  return checkout === undefined
    ? Effect.fail(new JfbFailure({ message: "usage: jfb:install <path of a js-framework-benchmark checkout>" }))
    : Effect.succeed(resolve(checkout))
}

const copyEntry = (keyedDir: string, name: string) =>
  Effect.tryPromise({
    try: () => rm(join(keyedDir, name), { recursive: true, force: true }).then(() => cp(join(OUT_KEYED, name), join(keyedDir, name), { recursive: true })),
    catch: failure(`cannot copy ${name}`)
  }).pipe(Effect.andThen(Console.log(`installed ${join(keyedDir, name)}`)))

/** Replaces `<checkout>/frameworks/keyed/<name>` with the built directory of each entry. */
const program = Effect.gen(function*() {
  const checkout = yield* checkoutFrom(process.argv)
  const keyedDir = join(checkout, "frameworks", "keyed")
  yield* requireDirectory(keyedDir, "pass the root of a js-framework-benchmark checkout")
  yield* Effect.forEach(ENTRIES, (entry) => requireDirectory(join(OUT_KEYED, entry.name), "run `pnpm --filter @mufw/example-jfb build` first"), {
    discard: true
  })
  yield* Effect.forEach(ENTRIES, (entry) => copyEntry(keyedDir, entry.name), { discard: true })
})

NodeRuntime.runMain(program)
