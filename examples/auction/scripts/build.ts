import { Effect, Schema } from "effect"
import { build, type Rollup } from "vite"

const root = new URL("..", import.meta.url).pathname

export class BuildFailure extends Schema.TaggedError<BuildFailure>()("BuildFailure", {
  deployment: Schema.String,
  message: Schema.String
}) {}

const isBuildOutput = (output: unknown): output is Rollup.RollupOutput =>
  typeof output === "object" && output !== null && "output" in output

/** What `vite build` returns when it built, as opposed to a watcher. */
const toRollupOutputs = (name: string, result: unknown) => {
  const outputs: ReadonlyArray<unknown> = Array.isArray(result) ? result : [result]
  const rollupOutputs = outputs.filter(isBuildOutput)
  return rollupOutputs.length === outputs.length
    ? Effect.succeed(rollupOutputs)
    : Effect.fail(new BuildFailure({ deployment: name, message: "vite returned a watcher, not a build" }))
}

/** Builds one deployment with `vite build --mode <deployment>`; `write: false` keeps the output in memory. */
export const buildDeployment = (deployment: string, options: { readonly write: boolean }) =>
  Effect.tryPromise({
    try: () => build({ root, mode: deployment, logLevel: options.write ? "warn" : "silent", build: { write: options.write } }),
    catch: (error) => new BuildFailure({ deployment, message: String(error) })
  }).pipe(Effect.flatMap((result) => toRollupOutputs(deployment, result)))

/**
 * Builds the module graph of `entry` (a path under the example) in memory, with no page around it.
 * A page's build emits a worker as an opaque file, minified, whose chunks report no modules; this
 * reports the worker's own.
 */
export const buildEntry = (entry: string) =>
  Effect.tryPromise({
    try: () => build({ root, configFile: false, logLevel: "silent", build: { write: false, lib: { entry, formats: ["es"] } } }),
    catch: (error) => new BuildFailure({ deployment: entry, message: String(error) })
  }).pipe(Effect.flatMap((result) => toRollupOutputs(entry, result)))
