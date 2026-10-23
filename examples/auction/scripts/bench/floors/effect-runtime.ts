import { Effect } from "effect"

/** Size floor, never run: the smallest program that needs Effect's runtime. */
Effect.runFork(Effect.sync(() => {
  document.title = "effect-runtime"
}))
