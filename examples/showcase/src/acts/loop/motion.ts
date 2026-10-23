import { Clock, Effect, Layer, Option, Stream } from "effect"
import { HOLD_MILLIS } from "../../domain/BoxOffice.ts"
import { LoopBoardPorts, type Representation } from "./board.ts"
import { firedStations, type Scene, settlesPayment, STATIONS } from "./scene.ts"

/** The light's hop from one station to the next. */
const HOP_MILLIS = 240
const FLASH_MILLIS = 900
const FADE_MILLIS = 420
const ACTION = STATIONS.indexOf("action")
const STATE = STATIONS.indexOf("state")

/** What the light does for a change of the board. */
export type Beat =
  | { readonly _tag: "Dispatched" }
  | { readonly _tag: "Played"; readonly from: number; readonly fired: ReadonlyArray<boolean> }

const sceneSeq = (representation: Representation): number | null =>
  Option.getOrNull(Option.map(representation.scene, (scene) => scene.seq))

/** A payment that was offstage returns to the stage at the Action; every other scene starts at the Intent. */
const startOf = (before: Representation, scene: Scene): number =>
  before.charging.some((charge) => settlesPayment(scene.proposal, charge.seat)) ? ACTION : 0

/** A new scene plays the light along the track; a payment leaving for the gateway sends it as far as the Action. */
export const beatBetween = (previous: Option.Option<Representation>, current: Representation): Option.Option<Beat> => {
  if (Option.isNone(previous)) return Option.none()
  const before = previous.value
  if (sceneSeq(before) !== sceneSeq(current)) {
    return Option.map(current.scene, (scene): Beat => ({
      _tag: "Played",
      from: startOf(before, scene),
      fired: firedStations(scene)
    }))
  }
  return current.charging.length > before.charging.length ? Option.some<Beat>({ _tag: "Dispatched" }) : Option.none()
}

const prefersStillness = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

const colourOf = (root: HTMLElement, name: string) => getComputedStyle(root).getPropertyValue(name).trim()

interface Rig {
  readonly light: HTMLElement
  readonly stations: ReadonlyArray<HTMLElement>
}

const rigOf = (root: HTMLElement): Rig | null => {
  const light = root.querySelector<HTMLElement>(".loop__light")
  const stations = Array.from(root.querySelectorAll<HTMLElement>("[data-station]"))
  return light === null || stations.length !== STATIONS.length ? null : { light, stations }
}

const centreOf = (station: HTMLElement) => station.offsetLeft + station.offsetWidth / 2

const flash = (station: HTMLElement, strength: number, delay: number) =>
  station.animate(
    [{ "--loop-flash": 0 }, { "--loop-flash": strength, offset: 0.3 }, { "--loop-flash": 0 }],
    { duration: FLASH_MILLIS, delay, easing: "ease-out" }
  )

/** The light leaves the Intent for the Action and stays there, offstage, until the stage answers. */
const sendOffstage = (root: HTMLElement, rig: Rig) => {
  const [intent, action] = rig.stations
  if (intent === undefined || action === undefined) return
  rig.light.getAnimations().forEach((animation) => animation.cancel())
  rig.light.animate(
    [
      {
        transform: `translateX(${centreOf(intent)}px)`,
        backgroundColor: colourOf(root, "--limelight"),
        opacity: 1
      },
      {
        transform: `translateX(${centreOf(action)}px)`,
        backgroundColor: colourOf(root, "--standby-blue"),
        opacity: 1
      }
    ],
    { duration: HOP_MILLIS * 2, easing: "ease-in-out", fill: "forwards" }
  )
  flash(intent, 0.6, 0)
}

/** The light runs from `from` to the State, then fades; the stations it passes flash, the NAP last. */
const runLight = (root: HTMLElement, rig: Rig, from: number, fired: ReadonlyArray<boolean>) => {
  const hops = rig.stations.slice(from, STATE + 1)
  const last = hops.at(-1)
  if (last === undefined) return
  const limelight = colourOf(root, "--limelight")
  const total = (hops.length - 1) * HOP_MILLIS + FADE_MILLIS
  const frames = hops.map((station, index) => ({
    transform: `translateX(${centreOf(station)}px)`,
    backgroundColor: index === 0 && from === ACTION ? colourOf(root, "--standby-blue") : limelight,
    opacity: 1,
    offset: (index * HOP_MILLIS) / total,
    easing: "ease-in-out"
  }))
  const fade = { transform: `translateX(${centreOf(last)}px)`, backgroundColor: limelight, opacity: 0, offset: 1 }
  rig.light.getAnimations().forEach((animation) => animation.cancel())
  rig.light.animate([...frames, fade], { duration: total, fill: "forwards" })
  rig.stations.forEach((station, index) => {
    if (index < from) return
    flash(station, fired[index] === true ? 1 : 0.4, (index - from) * HOP_MILLIS)
  })
}

const perform = (root: HTMLElement, beat: Beat) =>
  Effect.sync(() => {
    const rig = rigOf(root)
    if (rig === null || prefersStillness()) return
    if (beat._tag === "Dispatched") sendOffstage(root, rig)
    else runLight(root, rig, beat.from, beat.fired)
  })

/**
 * Runs the light along the track for every new scene of the board, and sends it offstage while a
 * payment is away. The animations belong to the DOM, so they run here and never in the view; the
 * stations stay in the markup for good, so a repaint never cuts one short.
 */
export const layerLight = (root: HTMLElement) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const board = yield* LoopBoardPorts.ModelPort
      const changes = Stream.zipWithPrevious(board.representations)
      const play = ([previous, current]: readonly [Option.Option<Representation>, Representation]) =>
        Option.match(beatBetween(previous, current), {
          onNone: () => Effect.void,
          onSome: (beat) => perform(root, beat)
        })
      yield* Effect.forkScoped(Stream.runForEach(changes, play))
    })
  )

/** Long enough for the mount's paint of the same representation to have put the ring in the DOM. */
const PAINT_MILLIS = 30

const RING_PREFIX = "hold:"

const ringAnimationsOf = (ring: HTMLElement) => ring.getAnimations().filter((animation) => animation.id.startsWith(RING_PREFIX))

/**
 * Puts the ring of one held seat at the point the clock says its hold has reached. A ring already
 * draining keeps going; with reduced motion the ring is a still picture, redrawn every time.
 */
const tendRing = (ring: HTMLElement, now: number, still: boolean) => {
  const until = Number(ring.dataset.holdUntil)
  if (!Number.isFinite(until)) return
  const id = `${RING_PREFIX}${until}`
  const [known] = ringAnimationsOf(ring).filter((animation) => animation.id === id)
  if (known !== undefined && !still) return
  ringAnimationsOf(ring).filter((animation) => animation.id !== id).forEach((animation) => animation.cancel())
  const animation = known ?? ring.animate([{ "--ring": 1 }, { "--ring": 0 }], {
    duration: HOLD_MILLIS,
    easing: "linear",
    fill: "both"
  })
  animation.id = id
  animation.currentTime = Math.min(HOLD_MILLIS, Math.max(0, HOLD_MILLIS - (until - now)))
  if (still) animation.pause()
}

const tendRings = (root: HTMLElement, now: number) =>
  Effect.sync(() => {
    const still = prefersStillness()
    root.querySelectorAll<HTMLElement>("[data-hold-until]").forEach((ring) => tendRing(ring, now, still))
  })

/**
 * Starts the draining ring of every held seat. The ring's animation lasts `HOLD_MILLIS` and begins at
 * the point the clock says the hold has reached, so a repaint, or an act that was hidden for a while,
 * never shows a ring fuller than its hold.
 */
export const layerRings = (root: HTMLElement) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const board = yield* LoopBoardPorts.ModelPort
      const tend = Effect.gen(function*() {
        yield* Effect.sleep(PAINT_MILLIS)
        const now = yield* Clock.currentTimeMillis
        yield* tendRings(root, now)
      })
      yield* Effect.forkScoped(Stream.runForEach(board.representations, () => tend))
    })
  )
