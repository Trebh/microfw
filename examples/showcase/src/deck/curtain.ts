import { Effect, Layer, Option, Stream } from "effect"
import { DeckPorts } from "./Deck.ts"
import { cssMillis } from "./timing.ts"

export interface CurtainRoots {
  /** The proscenium: it carries `data-curtain="open" | "closed"`, which the stylesheet turns into the velvet halves, or a crossfade under reduced motion. */
  readonly frame: HTMLElement
  /** Holds one `section.act` per act. */
  readonly stage: HTMLElement
}

const showOnly = (stage: HTMLElement, actId: string) => {
  stage.querySelectorAll<HTMLElement>(".act").forEach((section) => {
    section.hidden = section.id !== `act-${actId}`
  })
}

/** Closes the curtain, swaps the acts behind it, opens it. The closing length is the stylesheet's own. */
const changeAct = ({ frame, stage }: CurtainRoots, actId: string) =>
  Effect.gen(function*() {
    const closing = yield* cssMillis("--dur-curtain-half")
    yield* Effect.sync(() => {
      frame.dataset.curtain = "closed"
    })
    yield* Effect.sleep(closing)
    yield* Effect.sync(() => {
      showOnly(stage, actId)
      frame.dataset.curtain = "open"
    })
  })

/**
 * Shows the act the deck is on. The first act is simply there; every later change of act goes
 * behind the curtain. A change that arrives while the curtain is moving takes over from it.
 */
export const layerCurtain = (roots: CurtainRoots) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const model = yield* DeckPorts.ModelPort
      const perform = ([previous, actId]: readonly [Option.Option<string>, string]) =>
        Option.isNone(previous) ? Effect.sync(() => showOnly(roots.stage, actId)) : changeAct(roots, actId)
      const shown = model.representations.pipe(
        Stream.map((representation) => representation.actId),
        Stream.changes,
        Stream.zipWithPrevious,
        Stream.switchMap((change) => Stream.fromEffectDrain(perform(change)))
      )
      yield* Effect.forkScoped(Stream.runDrain(shown))
    })
  )
