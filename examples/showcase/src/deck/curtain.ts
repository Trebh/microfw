import { Effect, FiberHandle, Layer, Option, Stream } from "effect"
import { DeckPorts } from "./Deck.ts"
import { cssMillis } from "./timing.ts"

export interface CurtainRoots {
  /** The proscenium: it carries `data-curtain="open" | "closed"`, which the stylesheet turns into the velvet halves, or a crossfade under reduced motion. */
  readonly frame: HTMLElement
  /** Holds one `section.act` per act. */
  readonly stage: HTMLElement
}

const showOnly = (stage: HTMLElement, actId: string) => {
  stage.querySelectorAll<HTMLElement>(":scope > .act").forEach((section) => {
    section.hidden = section.id !== `act-${actId}`
  })
}

const setCurtain = (frame: HTMLElement, position: "open" | "closed") =>
  Effect.sync(() => {
    frame.dataset.curtain = position
  })

/** Closes the curtain, swaps the acts behind it, opens it. The closing length is the stylesheet's own. */
const changeAct = ({ frame, stage }: CurtainRoots, actId: string) =>
  Effect.gen(function*() {
    const closing = yield* cssMillis("--dur-curtain-half")
    yield* setCurtain(frame, "closed")
    yield* Effect.sleep(closing)
    yield* Effect.sync(() => showOnly(stage, actId))
    yield* setCurtain(frame, "open")
  })

/**
 * Shows the act the deck is on. The first act is simply there; every later change of act goes
 * behind the curtain. A change that arrives while the curtain is moving replaces the one in
 * progress: each change runs in a fiber of its own, held by a handle that interrupts its
 * predecessor, so the curtain's timing depends on nothing but its own sleep.
 */
export const layerCurtain = (roots: CurtainRoots) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const model = yield* DeckPorts.ModelPort
      const performing = yield* FiberHandle.make()
      const perform = ([previous, actId]: readonly [Option.Option<string>, string]) =>
        Option.isNone(previous)
          ? Effect.sync(() => showOnly(roots.stage, actId))
          : FiberHandle.run(performing, changeAct(roots, actId)).pipe(Effect.asVoid)
      const changes = model.representations.pipe(
        Stream.map((representation) => representation.actId),
        Stream.changes,
        Stream.zipWithPrevious
      )
      yield* Effect.forkScoped(Stream.runForEach(changes, perform))
    })
  )
