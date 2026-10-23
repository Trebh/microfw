import { Effect, FiberSet, Layer, Option, Ref, Schedule, Stream } from "effect"
import type { ActScript } from "../act.ts"
import { DeckPorts, type Representation } from "./Deck.ts"
import { cssMillis } from "./timing.ts"

export interface SpotlightRoots {
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

/** The ellipse's radii leave a bright core wider than the element, then fall off over the rest. */
const CORE_FACTOR = 1.9
const MARGIN_X = 90
const MARGIN_Y = 70
const SEARCH_ATTEMPTS = 10
const SEARCH_EVERY_MILLIS = 100

/** Moves the ellipse onto `target`. An element that is not displayed (an act behind the curtain) has no box and is left for the observer to place. */
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

/**
 * Lights the element the current cue's `spot` names, or the whole stage when the cue has none.
 * The ellipse travels over the spot's own duration, then follows resizes and scrolling closely.
 * A spot the act's markup does not carry is logged and the stage stays fully lit.
 */
export const layerSpotlight = (scripts: ReadonlyArray<ActScript>, roots: SpotlightRoots) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const { stage, overlay } = roots
      const model = yield* DeckPorts.ModelPort
      const runFork = yield* FiberSet.makeRuntime()
      const aimed = yield* Ref.make<Option.Option<HTMLElement>>(Option.none())

      const realign = Ref.get(aimed).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (target) => Effect.sync(() => aim(overlay, target)) }))
      )
      const follow = () => runFork(realign)

      const observer = yield* Effect.acquireRelease(
        Effect.sync(() => new ResizeObserver(follow)),
        (resizes) => Effect.sync(() => resizes.disconnect())
      )
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          window.addEventListener("resize", follow)
          window.addEventListener("scroll", follow, { capture: true, passive: true })
        }),
        () =>
          Effect.sync(() => {
            window.removeEventListener("resize", follow)
            window.removeEventListener("scroll", follow, { capture: true })
          })
      )

      const shine = (target: HTMLElement | null) =>
        Effect.gen(function*() {
          yield* Ref.set(aimed, Option.fromNullishOr(target))
          yield* Effect.sync(() => {
            observer.disconnect()
            overlay.dataset.moving = "true"
            if (target === null) {
              setDim(overlay, 0)
              return
            }
            observer.observe(target)
            aim(overlay, target)
            const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches
            target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: calm ? "auto" : "smooth" })
            setDim(overlay, 1)
          })
          const travelling = yield* cssMillis("--dur-spot")
          yield* Effect.sleep(travelling)
          yield* Effect.sync(() => {
            overlay.dataset.moving = "false"
          })
        })

      // An act's island renders in its own layer, which may build after the first cue is up.
      const searchSpot = (actId: string, spot: string) =>
        Effect.suspend(() => {
          const target = findSpot(stage, actId, spot)
          return target === null ? Effect.fail("SpotMissing" as const) : Effect.succeed(target)
        }).pipe(Effect.retry({ times: SEARCH_ATTEMPTS, schedule: Schedule.spaced(SEARCH_EVERY_MILLIS) }))

      const light = (position: Position) => {
        const spot = spotOf(scripts, position)
        if (spot === null) return shine(null)
        const missing = Effect.logWarning(`no [data-spot="${spot}"] in act ${position.actId}`).pipe(
          Effect.andThen(shine(null))
        )
        return searchSpot(position.actId, spot).pipe(
          Effect.option,
          Effect.flatMap(Option.match({ onNone: () => missing, onSome: shine }))
        )
      }

      const positions = model.representations.pipe(
        Stream.map((representation): Position => ({ actId: representation.actId, cue: representation.cue })),
        Stream.changesWith((a, b) => a.actId === b.actId && a.cue === b.cue),
        Stream.switchMap((position) => Stream.fromEffectDrain(light(position)))
      )
      yield* Effect.forkScoped(Stream.runDrain(positions))
    })
  )
