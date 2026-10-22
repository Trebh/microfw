import { BrowserRuntime, BrowserWorkerRunner } from "@effect/platform-browser"
import { Layer } from "effect"
import { workerHost } from "./placements/workerHost.ts"

/** The worker's composition root: serves the auction over the page's message channel until the page closes. */
BrowserRuntime.runMain(Layer.launch(workerHost.pipe(Layer.provide(BrowserWorkerRunner.layer))))
