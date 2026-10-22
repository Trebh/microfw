import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { rm } from "node:fs/promises"
import { buildDeployment } from "./build.ts"
import { pages } from "./pages.ts"

/** One `vite build` per deployment, each into `dist/<deployment>`; a stale `dist` is removed first. */
const program = Effect.gen(function*() {
  yield* Effect.promise(() => rm(new URL("../dist", import.meta.url), { recursive: true, force: true }))
  yield* Effect.forEach(
    Object.keys(pages),
    (deployment) => buildDeployment(deployment, { write: true }).pipe(Effect.andThen(Console.log(`built dist/${deployment}`))),
    { discard: true }
  )
})

NodeRuntime.runMain(program)
