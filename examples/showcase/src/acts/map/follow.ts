import type { Forward, Ports } from "@mufw/core"
import { Effect, Layer, Option, Stream } from "effect"
import type { Deck } from "../../deck/Deck.ts"
import { BoxOfficePorts } from "../../domain/BoxOffice.ts"
import { type Chart, crossingsBetween } from "./chart.ts"
import { script } from "./script.ts"
import type { Intent, Survey } from "./Survey.ts"

/** The cues during which the light walks: the floor, then the stage directions. */
const WALK_CUES: ReadonlyArray<number> = [4, 5]

const isWalkCue = (position: { readonly actId: string; readonly cue: number }): boolean =>
  position.actId === script.id && WALK_CUES.includes(position.cue)

/** The stage manager cues the light: it starts when the deck comes to the walk, and rests when the deck leaves it. */
export const forwardWalk: Forward<typeof Deck, Survey> = (previous, current) => {
  const wasWalking = Option.isSome(previous) && isWalkCue(previous.value)
  const isWalking = isWalkCue(current)
  if (isWalking && !wasWalking) return Option.some<Intent>({ _tag: "Begin" })
  return wasWalking && !isWalking ? Option.some<Intent>({ _tag: "Rest" }) : Option.none()
}

/**
 * Follows the shared stage: every step its history records is read against the one before it for
 * what it crossed, and the control state it stands in is the spike mark that glows.
 */
export const layerFollowStage = (chart: Chart, ports: Ports<Survey>) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const history = yield* BoxOfficePorts.HistoryPort
      const stage = yield* BoxOfficePorts.ModelPort
      const survey = yield* ports.ModelPort
      const crossed = Stream.runForEach(history.records.pipe(Stream.zipWithPrevious), ([previous, record]) =>
        Option.match(previous, {
          onNone: () => Effect.void,
          onSome: (before) =>
            Effect.forEach(crossingsBetween(chart, before, record), (proposal) => survey.present(proposal), {
              discard: true
            })
        }))
      const standing = Stream.runForEach(stage.representations, (representation) =>
        survey.present({ _tag: "Stood", place: representation.controlState }))
      yield* Effect.forkScoped(crossed)
      yield* Effect.forkScoped(standing)
    })
  )
