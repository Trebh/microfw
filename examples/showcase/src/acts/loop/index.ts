import { type Forward, type HistoryPort, type IntentPort, layerForward, layerLoopLocal, type ModelPort } from "@mufw/core"
import { layerMount } from "@mufw/view-uhtml"
import { Effect, Layer, Option, Stream } from "effect"
import { render } from "uhtml"
import type { Act } from "../../act.ts"
import { DeckPorts, type Deck, type Representation as DeckRepresentation } from "../../deck/Deck.ts"
import { type BoxOffice, BoxOfficePorts } from "../../domain/BoxOffice.ts"
import type { CurrentPatron } from "../../domain/CurrentPatron.ts"
import { LoopBoard, LoopBoardPorts } from "./LoopBoard.ts"
import { layerLight, layerRings } from "./motion.ts"
import { script } from "./script.ts"
import "./style.css"
import { view } from "./view.ts"

/** What the act asks of the composition root: the shared stage, the deck's cues, and who is buying. */
export type LoopServices =
  | IntentPort<typeof BoxOffice>
  | ModelPort<typeof BoxOffice>
  | HistoryPort<typeof BoxOffice>
  | ModelPort<typeof Deck>
  | CurrentPatron

const isInThisAct = (representation: DeckRepresentation) => representation.actId === script.id

/** The stage manager cues the board when the deck walks into this act; the board opens the doors if the stage is still dark. */
export const openHouseOnEntry: Forward<typeof Deck, typeof LoopBoard> = (previous, current) =>
  isInThisAct(current) && !Option.exists(previous, isInThisAct)
    ? Option.some({ _tag: "OpenHouse" } as const)
    : Option.none()

/** Every record the shared stage commits, in order, becomes a proposal of the board. */
const layerWitness = Layer.effectDiscard(
  Effect.gen(function*() {
    const stage = yield* BoxOfficePorts.HistoryPort
    const board = yield* LoopBoardPorts.ModelPort
    yield* Effect.forkScoped(
      Stream.runForEach(stage.records, (record) => board.present({ _tag: "Witnessed", record }))
    )
  })
)

/**
 * Act I. One island over the board: a loop of its own that watches the shared box office's records
 * and relays the audience's intents to it. The house and the step are two views of one
 * representation, so a click shows in both at the same repaint.
 */
export const loopAct: Act<LoopServices> = {
  script,
  layer: (root) =>
    Layer.mergeAll(
      layerMount(LoopBoardPorts, {
        root,
        view,
        render,
        onRefused: (refused) => Effect.logWarning(refused)
      }),
      layerWitness,
      layerForward(DeckPorts, LoopBoardPorts, openHouseOnEntry),
      layerLight(root),
      layerRings(root)
    ).pipe(Layer.provide(layerLoopLocal(LoopBoard, LoopBoardPorts)))
}
