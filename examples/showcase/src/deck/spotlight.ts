import { Effect, FiberHandle, FiberSet, Layer, Option, Ref, Schedule, Stream } from "effect"
import type { ActScript } from "../act.ts"
import { DeckPorts, type Representation } from "./Deck.ts"
import { cssMillis } from "./timing.ts"

export interface SpotlightRoots {
  /** The proscenium; its `data-curtain` says when an act has been revealed. */
  readonly frame: HTMLElement
  /** Holds the acts. */
  readonly stage: HTMLElement
  /** Covers the stage; the stylesheet draws a dimmed field with a soft ellipse of light from its `--spot-*` properties. */
  readonly overlay: HTMLElement
}

type Position = Pick<Representation, "actId" | "cue">

const spotOf = (scripts: ReadonlyArray<ActScript>, position: Position): string | null =>
  scripts.find((script) => script.id === position.actId)?.cues[position.cue]?.spot ?? null

const findSpot = (stage: HTMLElement, actId: string, spot: string): HTMLElement | null =>
  stage.querySelector<HTMLElement>(`#${CSS.escape(`act-${actId}`)} [data-spot="${CSS.escape(spot)}"]`)

/** An element in a hidden act has no box: it cannot be lit yet. */
const isDisplayed = (element: HTMLElement) => element.getClientRects().length > 0

/** The ellipse is wider than the element it lights: a bright core past its edges, then the fall-off. */
const CORE_FACTOR = 2.2
const MARGIN_X = 140
const MARGIN_Y = 110
/** An act's island may render after its first cue is up, and a hidden act is shown by the curtain. */
const SEARCH_ATTEMPTS = 30
const SEARCH_EVERY_MILLIS = 50

const aim = (overlay: HTMLElement, target: HTMLElement) => {
  const spot = target.getBoundingClientRect()
  if (spot.width === 0 && spot.height === 0) return
  const field = overlay.getBoundingClientRect()
  overlay.style.setProperty("--spot-x", `${spot.left + spot.width / 2 - field.left}px`)
  overlay.style.setProperty("--spot-y", `${spot.top + spot.height / 2 - field.top}px`)
  overlay.style.setProperty("--spot-rx", `${(spot.width / 2) * CORE_FACTOR + MARGIN_X}px`)
  overlay.style.setProperty("--spot-ry", `${(spot.height / 2) * CORE_FACTOR + MARGIN_Y}px`)
}

const setDim = (overlay: HTMLElement, dim: 0 | 1) => overlay.style.setProperty("--spot-dim", String(dim))

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * Lights the element the current cue's `spot` names, or the whole stage when the cue has none.
 * The ellipse travels over the spot's own duration, is measured again when it arrives, and then
 * follows the target and the stage: a resize of either, scrolling, and the curtain opening on the act.
 * A spot the act's markup does not carry is logged and the stage stays fully lit.
 */
export const layerSpotlight = (scripts: ReadonlyArray<ActScript>, roots: SpotlightRoots) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const { frame, stage, overlay } = roots
      const model = yield* DeckPorts.ModelPort
      const runFork = yield* FiberSet.makeRuntime()
      const aimed = yield* Ref.make<Option.Option<HTMLElement>>(Option.none())

      const realign = Ref.get(aimed).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (target) => Effect.sync(() => aim(overlay, target))
          })
        )
      )
      const follow = () => runFork(realign)

      const resizes = yield* Effect.acquireRelease(
        Effect.sync(() => new ResizeObserver(follow)),
        (observer) => Effect.sync(() => observer.disconnect())
      )
      const curtainMoves = yield* Effect.acquireRelease(
        Effect.sync(() => new MutationObserver(follow)),
        (observer) => Effect.sync(() => observer.disconnect())
      )
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          curtainMoves.observe(frame, { attributes: true, attributeFilter: ["data-curtain"] })
          window.addEventListener("resize", follow)
          window.addEventListener("scroll", follow, { capture: true, passive: true })
        }),
        () =>
          Effect.sync(() => {
            window.removeEventListener("resize", follow)
            window.removeEventListener("scroll", follow, { capture: true })
          })
      )

      const watch = (target: HTMLElement | null) =>
        Effect.sync(() => {
          resizes.disconnect()
          if (target === null) return
          resizes.observe(stage)
          resizes.observe(target)
        })

      const shine = (target: HTMLElement | null) =>
        Effect.gen(function*() {
          yield* Ref.set(aimed, Option.fromNullishOr(target))
          yield* watch(target)
          yield* Effect.sync(() => {
            overlay.dataset.moving = "true"
            if (target === null) {
              setDim(overlay, 0)
              return
            }
            aim(overlay, target)
            target.scrollIntoView({
              block: "nearest",
              inline: "nearest",
              behavior: prefersReducedMotion() ? "auto" : "smooth"
            })
            setDim(overlay, 1)
          })
          const travelling = yield* cssMillis("--dur-spot")
          yield* Effect.sleep(travelling)
          yield* realign
          yield* Effect.sync(() => {
            overlay.dataset.moving = "false"
          })
        })

      const searchSpot = (actId: string, spot: string) =>
        Effect.suspend(() => {
          const target = findSpot(stage, actId, spot)
          const isReady = target !== null && isDisplayed(target)
          return isReady ? Effect.succeed(target) : Effect.fail("SpotNotReady" as const)
        }).pipe(Effect.retry({ times: SEARCH_ATTEMPTS, schedule: Schedule.spaced(SEARCH_EVERY_MILLIS) }))

      const light = (position: Position) => {
        const spot = spotOf(scripts, position)
        if (spot === null) return shine(null)
        const missing = Effect.logWarning(`no displayed [data-spot="${spot}"] in act ${position.actId}`).pipe(
          Effect.andThen(shine(null))
        )
        return searchSpot(position.actId, spot).pipe(
          Effect.option,
          Effect.flatMap(Option.match({ onNone: () => missing, onSome: shine }))
        )
      }

      const performing = yield* FiberHandle.make()
      const lightUp = (position: Position) => FiberHandle.run(performing, light(position)).pipe(Effect.asVoid)
      const positions = model.representations.pipe(
        Stream.map((representation): Position => ({ actId: representation.actId, cue: representation.cue })),
        Stream.changesWith((a, b) => a.actId === b.actId && a.cue === b.cue)
      )
      yield* Effect.forkScoped(Stream.runForEach(positions, lightUp))
    })
  )
