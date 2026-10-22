import type { DispatchRefused } from "@mufw/core"
import { Context, Effect, Layer, Option, Stream, SubscriptionRef } from "effect"

export type Refusal = Option.Option<DispatchRefused>

/**
 * The latest dispatch the server refused, as data apart from the SAM representation: neither the
 * domain nor the model knows about it. The view's dispatch reports into it; the notice reads it.
 */
export class Refusals extends Context.Service<Refusals, {
  readonly report: (refused: DispatchRefused) => Effect.Effect<void>
  /** Emits the current refusal first (`none` until one is reported), then every change. */
  readonly latest: Stream.Stream<Refusal>
}>()("auction/Refusals") {}

export const layerRefusals = Layer.effect(
  Refusals,
  Effect.gen(function*() {
    const latest = yield* SubscriptionRef.make<Refusal>(Option.none())
    return {
      report: (refused) => SubscriptionRef.set(latest, Option.some(refused)),
      latest: SubscriptionRef.changes(latest)
    }
  })
)

/** How long a refusal stays on the page unless a newer one replaces it. */
export const NOTICE_DURATION = "6 seconds"

const clearedAfterNotice = Stream.fromEffect(
  Effect.sleep(NOTICE_DURATION).pipe(Effect.as(Option.none<DispatchRefused>()))
)

/** A refusal is followed by `none` once its time is up; a newer refusal restarts the clock. */
export const expiring = (refusals: Stream.Stream<Refusal>): Stream.Stream<Refusal> =>
  Stream.switchMap(
    refusals,
    (refusal) =>
      Option.isNone(refusal)
        ? Stream.succeed(refusal)
        : Stream.concat(Stream.succeed(refusal), clearedAfterNotice)
  )
