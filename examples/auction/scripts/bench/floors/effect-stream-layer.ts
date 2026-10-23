import { Context, Effect, Layer, PubSub, Schema, Stream, SubscriptionRef } from "effect"

const Intent = Schema.Union([Schema.TaggedStruct("Inc", { by: Schema.Int })])

const Representation = Schema.Struct({
  controlState: Schema.Literals(["even", "odd"]),
  count: Schema.Int,
  intent: Intent
})

const decode = Schema.decodeUnknownEffect(Representation)

class Counting extends Context.Service<Counting, {
  readonly changes: Stream.Stream<number>
  readonly increment: Effect.Effect<void>
}>()("floor/Counting") {}

const layerCounting = Layer.effect(
  Counting,
  Effect.gen(function*() {
    const count = yield* SubscriptionRef.make(0)
    const published = yield* PubSub.sliding<number>(64)
    return {
      changes: Stream.merge(SubscriptionRef.changes(count), Stream.fromPubSub(published)),
      increment: SubscriptionRef.update(count, (n) => n + 1).pipe(Effect.andThen(PubSub.publish(published, 1)))
    }
  })
)

/**
 * Size floor, never run: the Effect surface `@mufw/core`'s local loop relies on (a service key, a
 * layer, a subscription ref, a pub-sub and a stream run to completion) plus schema decoding.
 */
const program = Effect.gen(function*() {
  const counting = yield* Counting
  yield* counting.increment
  const seen = yield* counting.changes.pipe(Stream.take(2), Stream.runCollect)
  const input: unknown = JSON.parse(document.title)
  const representation = yield* decode(input)
  document.title = `${representation.controlState} ${seen.length}`
})

Effect.runFork(program.pipe(Effect.provide(layerCounting)))
