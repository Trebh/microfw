import { Cause, Effect, Layer, Option, Stream } from "effect"
import type { AnyDefinition, IntentOf, RepresentationOf } from "./Definition.ts"
import type { Ports } from "./Ports.ts"

/**
 * Maps a change of one definition's representation to the intent it asks of another. Pure, and it
 * sees the previous representation (`none` for the first one), so deduplication is the caller's
 * rule: return `none` when nothing relevant changed.
 */
export type Forward<A extends AnyDefinition, B extends AnyDefinition> = (
  previous: Option.Option<RepresentationOf<A>>,
  current: RepresentationOf<A>
) => Option.Option<IntentOf<B>>

/**
 * Feeds one definition's loop from another's: every representation of `from` goes through
 * `forward`, and each intent it returns is dispatched through `to.IntentPort`, in order. The
 * representations come from the port, so `from` may run anywhere (local or remote); `to` may too.
 *
 * A `DispatchRefused` is logged at warning level and the next representation is still forwarded. A
 * defect, whether from `to.IntentPort.dispatch` (a remote port turns a lost transport into one) or a
 * throw from `forward`, is logged at error level with the cause, and the next representation is
 * still forwarded: the fiber is never ended by one bad element. The fiber is scoped to the layer,
 * and the per-request services `R` of `to` are those of the layer's build, not of a caller.
 */
export const layerForward = <A extends AnyDefinition, B extends AnyDefinition, R = never>(
  from: Ports<A>,
  to: Ports<B, R>,
  forward: Forward<A, B>
) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const source = yield* from.ModelPort
      const target = yield* to.IntentPort
      const dispatch = (intent: IntentOf<B>) =>
        target.dispatch(intent).pipe(
          Effect.catchTag(
            "DispatchRefused",
            (refused) => Effect.logWarning("forwarded intent refused", refused.intentTag, refused.message)
          ),
          Effect.catchDefect((defect) => Effect.logError("forwarded intent died", intent._tag, Cause.die(defect)))
        )
      const forwardChange = ([previous, current]: readonly [Option.Option<RepresentationOf<A>>, RepresentationOf<A>]) =>
        Effect.sync(() => forward(previous, current)).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: dispatch })),
          Effect.catchDefect((defect) => Effect.logError("forward died", Cause.die(defect)))
        )
      yield* Effect.forkScoped(Stream.runForEach(Stream.zipWithPrevious(source.representations), forwardChange))
    })
  )
