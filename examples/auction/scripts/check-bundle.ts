import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Schema } from "effect"
import { buildDeployment } from "./build.ts"

class BundleCheckFailure extends Schema.TaggedError<BundleCheckFailure>()("BundleCheckFailure", {
  deployment: Schema.String,
  message: Schema.String
}) {}

/**
 * The local halves of the loop, as exports of `@mufw/core`. The bundler reports which exports of
 * each module it kept, so the names survive minification and tree-shaking decides the answer.
 */
const LOCAL_MODEL = "layerModelLocal"
const LOCAL_ACTION_RUNNER = "layerActionRunnerLocal"

/**
 * What each deployment must and must not ship. The `present` entries are the control: a deployment
 * that does run the half locally must show it, otherwise the check would pass on a stale name.
 */
const expectations: ReadonlyArray<{
  readonly deployment: string
  readonly present: ReadonlyArray<string>
  readonly absent: ReadonlyArray<string>
}> = [
  { deployment: "server-owned", present: [], absent: [LOCAL_MODEL, LOCAL_ACTION_RUNNER] },
  { deployment: "browser-only", present: [LOCAL_MODEL, LOCAL_ACTION_RUNNER], absent: [] },
  { deployment: "server-model", present: [LOCAL_ACTION_RUNNER], absent: [LOCAL_MODEL] },
  { deployment: "server-actions", present: [LOCAL_MODEL], absent: [LOCAL_ACTION_RUNNER] }
]

const checkDeployment = Effect.fn("checkDeployment")(function*(expected: (typeof expectations)[number]) {
  const outputs = yield* buildDeployment(expected.deployment, { write: false })
  const kept = new Set(
    outputs
      .flatMap((bundle) => bundle.output)
      .flatMap((file) => file.type === "chunk" ? Object.values(file.modules) : [])
      .flatMap((module) => module.renderedExports)
  )
  const problems = [
    ...expected.absent.filter((name) => kept.has(name)).map((name) => `ships ${name}`),
    ...expected.present.filter((name) => !kept.has(name)).map((name) => `lacks ${name}`)
  ]
  if (problems.length > 0) return yield* new BundleCheckFailure({ deployment: expected.deployment, message: `${expected.deployment}: ${problems.join(", ")}` })
  yield* Console.log(`ok ${expected.deployment}`)
})

NodeRuntime.runMain(Effect.forEach(expectations, checkDeployment, { discard: true }))
