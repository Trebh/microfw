import { BrowserRuntime, BrowserWorkerRunner } from "@effect/platform-browser"
import { Cause, Exit, Layer, Runtime } from "effect"
import { workerHost } from "./placements/workerHost.ts"

/**
 * The page learns of a worker's death only from an `error` event on the `Worker`, which an uncaught
 * error raises; a failed `runMain` only logs and leaves the worker idle, still reported as ready.
 * So a failure is re-raised as an error event, and the worker closes, since it serves nothing.
 */
const reportFailureToPage: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
    reportError(Cause.squash(exit.cause))
    close()
  }
  Runtime.defaultTeardown(exit, onExit)
}

/** The worker's composition root: serves the auction over the page's message channel until the page closes. */
BrowserRuntime.runMain(Layer.launch(workerHost.pipe(Layer.provide(BrowserWorkerRunner.layer))), {
  teardown: reportFailureToPage
})
