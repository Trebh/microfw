import { Effect, Schema } from "effect"

const Intent = Schema.Union([Schema.TaggedStruct("Inc", { by: Schema.Int })])

const Representation = Schema.Struct({
  controlState: Schema.Literals(["even", "odd"]),
  count: Schema.Int,
  intent: Intent
})

const decode = Schema.decodeUnknownEffect(Representation)

/** Size floor, never run: the runtime plus decoding an unknown value with the schemas a definition declares. */
Effect.runFork(
  Effect.sync((): unknown => JSON.parse(document.title)).pipe(
    Effect.flatMap(decode),
    Effect.tap((representation) =>
      Effect.sync(() => {
        document.title = `${representation.controlState} ${representation.count}`
      })
    )
  )
)
