import { Effect, Schema } from "effect"
import { build, type Rollup } from "vite"

const root = new URL("..", import.meta.url).pathname

export class BuildFailure extends Schema.TaggedError<BuildFailure>()("BuildFailure", {
  deployment: Schema.String,
  message: Schema.String
}) {}

/** Builds one deployment with `vite build --mode <deployment>`; `write: false` keeps the output in memory. */
export const buildDeployment = (deployment: string, options: { readonly write: boolean }) =>
  Effect.tryPromise({
    try: () => build({ root, mode: deployment, logLevel: options.write ? "warn" : "silent", build: { write: options.write } }),
    catch: (error) => new BuildFailure({ deployment, message: String(error) })
  }).pipe(
    Effect.flatMap((result) => {
      const outputs = Array.isArray(result) ? result : [result]
      const rollupOutputs = outputs.filter((output): output is Rollup.RollupOutput => "output" in output)
      return rollupOutputs.length === outputs.length
        ? Effect.succeed(rollupOutputs)
        : Effect.fail(new BuildFailure({ deployment, message: "vite returned a watcher, not a build" }))
    })
  )
