import { layerForward, layerLoopLocal, type ModelPort } from "@mufw/core"
import { Cause, Clock, Effect, FiberSet, Layer, Option, Ref, Stream, SubscriptionRef } from "effect"
import type { EventLogRemote } from "effect/eventlog"
import { html, render } from "uhtml"
import type { Act } from "../../act.ts"
import { type Deck, DeckPorts } from "../../deck/Deck.ts"
import type { Intent as SeatIntent } from "../../domain/BoxOffice.ts"
import type { PaymentGateway } from "../../domain/PaymentGateway.ts"
import { House, layerHouse, send, type Side, type TicketWindow } from "./house.ts"
import { appliedOf, initialScene, scene, type Scene, type SceneEvent } from "./scene.ts"
import "./style.css"
import { script } from "./script.ts"
import { cueStagehand, Stagehand, StagehandPorts } from "./stagehand.ts"
import { type Hands, view } from "./view.ts"
import { decodeEntry } from "./tape.ts"

/** The lease and the clock are read by polling: neither has a stream of its own. */
const POLL = "250 millis"

type SceneStream = Stream.Stream<SceneEvent, EventLogRemote.EventLogRemoteError>

/** Everything one window says about itself, tagged with its side. A window that closes ends its stream and leaves its last words on the scene. */
const windowEvents = (side: Side, window: TicketWindow): SceneStream => {
  const seats = window.model.representations.pipe(
    Stream.map((representation): SceneEvent => ({ _tag: "Seats", side, representation }))
  )
  const applied = window.checkpoints.pipe(
    Stream.map((checkpoint): SceneEvent => ({ _tag: "Applied", side, applied: appliedOf(checkpoint) }))
  )
  const chair = Stream.tick(POLL).pipe(
    Stream.mapEffect(() => window.holdsChair),
    Stream.changes,
    Stream.map((holds): SceneEvent => ({ _tag: "Chair", side, holds }))
  )
  return Stream.mergeAll([seats, applied, chair], { concurrency: "unbounded" })
}

const windowAEvents = (house: House["Service"]): SceneStream =>
  SubscriptionRef.changes(house.windowA).pipe(
    Stream.switchMap((current): SceneStream =>
      Option.isSome(current) ? windowEvents("A", current.value) : Stream.empty
    )
  )

const sceneEvents = (house: House["Service"], stage: Stream.Stream<SceneEvent>): SceneStream => {
  const log = house.log.pipe(
    Stream.mapEffect(decodeEntry),
    Stream.map((logged): SceneEvent => ({ _tag: "Logged", logged }))
  )
  const wire = SubscriptionRef.changes(house.onTheWire).pipe(
    Stream.map((count): SceneEvent => ({ _tag: "OnTheWire", count }))
  )
  const now = Stream.tick(POLL).pipe(
    Stream.mapEffect(() => Clock.currentTimeMillis),
    Stream.map((at): SceneEvent => ({ _tag: "Now", at }))
  )
  return Stream.mergeAll(
    [windowAEvents(house), windowEvents("B", house.windowB), log, wire, now, stage],
    { concurrency: "unbounded" }
  )
}

const sendToSide = (house: House["Service"], side: Side, intent: SeatIntent) => {
  const target: Effect.Effect<Option.Option<TicketWindow>> =
    side === "B" ? Effect.succeed(Option.some(house.windowB)) : SubscriptionRef.get(house.windowA)
  return Effect.flatMap(target, (found) => (Option.isSome(found) ? send(found.value, intent) : Effect.void))
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

/** A new entry is stamped on the tape and pushes the older ones down; a renewal folded into the top row only stamps it. */
const stampTape = (root: HTMLElement, pushed: boolean) => {
  if (prefersReducedMotion()) return
  const easing = getComputedStyle(root).getPropertyValue("--ease-ticket").trim() || "ease-out"
  const rows = Array.from(root.querySelectorAll<HTMLElement>(".tape__row"))
  rows[0]?.animate(
    [
      { opacity: 0, transform: "scale(1.7) rotate(-4deg)" },
      { opacity: 1, transform: "scale(1) rotate(0deg)" }
    ],
    { duration: 520, easing }
  )
  if (!pushed) return
  for (const older of rows.slice(1)) {
    older.animate([{ transform: "translateY(-100%)" }, { transform: "translateY(0)" }], { duration: 360, easing })
  }
}

/** Stamps the tape once per change of its top row, after the paint that put the row there. */
const stampNewest = (root: HTMLElement, seen: Ref.Ref<number>, current: Scene) =>
  Effect.gen(function*() {
    const top = current.tape.rows[0]?.seq ?? -1
    const before = yield* Ref.getAndSet(seen, top)
    if (top === before) return
    const pushed = current.tape.rows[1]?.seq === before
    yield* Effect.sync(() => stampTape(root, pushed))
  })

/**
 * Paints the whole act from the scene the windows, the log and the stage manager fold into. A seat
 * clicked in a window goes to that window's loop; the controls go to the stage manager's.
 */
const layerPainter = (root: HTMLElement) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const house = yield* House
      const stageModel = yield* StagehandPorts.ModelPort
      const stageIntents = yield* StagehandPorts.IntentPort
      const runFork = yield* FiberSet.makeRuntime<never>()
      const hands: Hands = {
        seat: (side, intent) => void runFork(sendToSide(house, side, intent)),
        stage: (intent) =>
          void runFork(
            stageIntents.dispatch(intent).pipe(
              Effect.catchTag("DispatchRefused", (refused) => Effect.logWarning("intent refused", refused.intentTag))
            )
          )
      }
      const stage = stageModel.representations.pipe(
        Stream.map((representation): SceneEvent => ({ _tag: "Stage", representation }))
      )
      const topSeq = yield* Ref.make(-1)
      const paint = (current: Scene) =>
        Effect.sync(() => render(root, view(current, hands))).pipe(Effect.andThen(stampNewest(root, topSeq, current)))
      const painting = Stream.runForEach(sceneEvents(house, stage).pipe(Stream.scan(() => initialScene, scene)), paint)
      yield* Effect.forkScoped(
        painting.pipe(Effect.catch((error) => Effect.logError("the log stopped reaching the tape", Cause.fail(error))))
      )
    })
  )

const layerFailed = (root: HTMLElement, failure: { readonly _tag: string }) =>
  Layer.effectDiscard(
    Effect.logError("the house could not open", failure._tag).pipe(
      Effect.andThen(
        Effect.sync(() =>
          render(
            root,
            html`<div class="sync sync--failed">
              <p class="marquee">The house could not open</p>
              <p class="mono">${failure._tag}</p>
            </div>`
          )
        )
      )
    )
  )

/**
 * Two box offices over one log. The house builds a log server in memory and two `layerLoopSynced`
 * loops of one definition against it, window A reading the server's own storage and window B
 * reaching it as a client would; the stage manager is a small loop of its own, cued by the deck.
 */
export const syncAct: Act<PaymentGateway | ModelPort<typeof Deck>> = {
  script,
  layer: (root) =>
    Layer.mergeAll(layerPainter(root), layerForward(DeckPorts, StagehandPorts, cueStagehand)).pipe(
      Layer.provide(layerLoopLocal(Stagehand, StagehandPorts)),
      Layer.provide(layerHouse),
      Layer.catch((failure) => layerFailed(root, failure))
    )
}
