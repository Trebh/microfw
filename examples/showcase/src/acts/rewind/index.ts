import {
  encodeHistoryJson,
  type Forward,
  type HistoryPort,
  type IntentPort,
  layerForward,
  layerLoopLocal,
  type ModelPort
} from "@mufw/core"
import { layerMount, type Render } from "@mufw/view-uhtml"
import { Effect, Layer, Option, Stream } from "effect"
import { render } from "uhtml"
import type { Act } from "../../act.ts"
import { Deck, DeckPorts, type Representation as DeckRepresentation } from "../../deck/Deck.ts"
import { BoxOffice, BoxOfficePorts } from "../../domain/BoxOffice.ts"
import type { BoxRecord } from "./reel.ts"
import { Rewind, RewindPorts } from "./Rewind.ts"
import "./style.css"
import { returnCue, script } from "./script.ts"
import { view } from "./view.ts"

const FILE_NAME = "box-office-history.json"

const isReturnCue = (representation: DeckRepresentation): boolean =>
  representation.actId === script.id && representation.cue === returnCue

const isEnteringReturnCue = (previous: Option.Option<DeckRepresentation>, current: DeckRepresentation): boolean =>
  isReturnCue(current) && !Option.exists(previous, isReturnCue)

/** The stage manager cues the actors: arriving at the cue that goes back asks the reel to travel. */
const forward: Forward<typeof Deck, typeof Rewind> = (previous, current) =>
  isEnteringReturnCue(previous, current) ? Option.some({ _tag: "ReturnToDoors" }) : Option.none()

/** Every record the stage makes, the retained ones first, becomes a proposal of the reel's own loop. */
const layerReel = Layer.effectDiscard(
  Effect.gen(function*() {
    const stage = yield* BoxOfficePorts.HistoryPort
    const reel = yield* RewindPorts.ModelPort
    yield* Effect.forkScoped(Stream.runForEach(stage.records, (record) => reel.present({ _tag: "Recorded", record })))
  })
)

const downloadFile = (name: string, json: string) =>
  Effect.sync(() => {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    link.download = name
    link.click()
    URL.revokeObjectURL(url)
  })

const saveReel = (records: ReadonlyArray<BoxRecord>) =>
  encodeHistoryJson(BoxOffice)(records).pipe(
    Effect.flatMap((json) => downloadFile(FILE_NAME, json)),
    Effect.catchTag("SchemaError", (error) => Effect.logError("the reel could not be encoded", error))
  )

/** The visitor takes the recording home: each rise of the export counter downloads the reel as it is. */
const layerExport = Layer.effectDiscard(
  Effect.gen(function*() {
    const reel = yield* RewindPorts.ModelPort
    const requests = reel.representations.pipe(
      Stream.zipWithPrevious,
      Stream.filter(([previous, current]) => Option.exists(previous, (before) => before.exports < current.exports))
    )
    yield* Effect.forkScoped(Stream.runForEach(requests, ([, current]) => saveReel(current.reel)))
  })
)

const prefersReducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches

/** Scrolls the film to the selected frame once per change of `data-follow`; nothing moves while the act is hidden. */
const followSelected = (root: HTMLElement): void => {
  const strip = root.querySelector<HTMLElement>(".film__strip")
  if (strip === null || strip.clientWidth === 0) return
  if (strip.dataset.followed === strip.dataset.follow) return
  const frame = strip.querySelector<HTMLElement>('[data-selected="true"]')
  if (frame === null) return
  strip.dataset.followed = strip.dataset.follow
  const centred = frame.offsetLeft - (strip.clientWidth - frame.offsetWidth) / 2
  strip.scrollTo({ left: centred, behavior: prefersReducedMotion() ? "auto" : "smooth" })
}

const renderFollowing = (root: HTMLElement): Render => (where, what) => {
  const rendered = render(where, what)
  followSelected(root)
  return rendered
}

/** The act is painted while hidden behind the curtain; when it is shown its box gets a size and the film catches up. */
const layerFollowOnShow = (root: HTMLElement) =>
  Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => {
        const observer = new ResizeObserver(() => followSelected(root))
        observer.observe(root)
        return observer
      }),
      (observer) => Effect.sync(() => observer.disconnect())
    )
  )

/**
 * The reel of the shared stage. The act's own loop (`Rewind`) holds the stage's records; its
 * `TravelTo` action calls the stage's `HistoryPort`, so a scrub is an intent like any other.
 */
export const rewindAct: Act<HistoryPort<typeof BoxOffice> | IntentPort<typeof BoxOffice> | ModelPort<typeof Deck>> = {
  script,
  layer: (root) =>
    Layer.mergeAll(
      layerMount(RewindPorts, {
        root,
        view,
        render: renderFollowing(root),
        onRefused: (refused) => Effect.logWarning(refused)
      }),
      layerReel,
      layerExport,
      layerFollowOnShow(root),
      layerForward(DeckPorts, RewindPorts, forward)
    ).pipe(Layer.provide(layerLoopLocal(Rewind, RewindPorts)))
}
