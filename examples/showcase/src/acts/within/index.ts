import { type DispatchRefused, layerForward, layerLoopLocal, type ModelPort } from "@mufw/core"
import { layerMount, layerMountReadOnly } from "@mufw/view-uhtml"
import { Effect, Layer, Stream } from "effect"
import { render } from "uhtml"
import type { Act } from "../../act.ts"
import { type Deck, DeckPorts } from "../../deck/Deck.ts"
import type { CurrentPatron } from "../../domain/CurrentPatron.ts"
import type { PaymentGateway } from "../../domain/PaymentGateway.ts"
import { dimTheHouse, openFrontDoors, repaintOnChange } from "./forward.ts"
import { layerHistoryRows } from "./history.ts"
import { Marquee } from "./marquee.ts"
import { FrontOfHouse, FrontPorts, MarqueePorts, Playhouse, PlayhousePorts } from "./playhouse.ts"
import "./style.css"
import { script } from "./script.ts"
import { frontView, makeSlots, playView, shell, type Slots, signView } from "./view.ts"

const refusedToLog = (refused: DispatchRefused) => Effect.logWarning(refused)

/** The three loops of the act: the nested play and its house, the box office out front, the sign. */
const loops = Layer.mergeAll(
  layerLoopLocal(Playhouse, PlayhousePorts),
  layerLoopLocal(FrontOfHouse, FrontPorts),
  layerLoopLocal(Marquee, MarqueePorts)
)

/** The house lights are the act's own background: the page follows the nested loop's brightness. */
const layerHouseLights = (root: HTMLElement) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const model = yield* PlayhousePorts.ModelPort
      const brightness = model.representations.pipe(
        Stream.map((representation) => representation.parent.brightness),
        Stream.changes
      )
      const shine = (level: number) => Effect.sync(() => root.style.setProperty("--house-lit", String(level)))
      yield* Effect.forkScoped(Stream.runForEach(brightness, shine))
    })
  )

const islands = (root: HTMLElement, slots: Slots) =>
  Layer.mergeAll(
    layerMount(PlayhousePorts, { root: slots.play, view: playView, render, onRefused: refusedToLog }),
    layerMount(FrontPorts, { root: slots.front, view: frontView, render, onRefused: refusedToLog }),
    layerMountReadOnly(MarqueePorts, { root: slots.sign, view: signView, render }),
    layerHistoryRows(PlayhousePorts, { root: slots.playHistory, title: Playhouse.name, limit: 12 }),
    layerHistoryRows(FrontPorts, { root: slots.frontHistory, title: FrontOfHouse.name, limit: 4 }),
    layerHistoryRows(MarqueePorts, { root: slots.signHistory, title: Marquee.name, limit: 4 }),
    layerHouseLights(root)
  )

/** The stage manager cues the actors, and the box office out front cues the sign: both are `layerForward`. */
const forwards = Layer.mergeAll(
  layerForward(FrontPorts, MarqueePorts, repaintOnChange),
  layerForward(DeckPorts, PlayhousePorts, dimTheHouse),
  layerForward(DeckPorts, FrontPorts, openFrontDoors)
)

/**
 * Two ways to compose definitions. On the left `nest` makes House and Mousetrap one definition on one
 * loop; on the right `layerForward` joins two loops, FrontOfHouse and Marquee, each with its own history.
 */
export const withinAct: Act<ModelPort<typeof Deck> | PaymentGateway | CurrentPatron> = {
  script,
  layer: (root) =>
    Layer.unwrap(
      Effect.sync(() => {
        const slots = makeSlots()
        render(root, shell(slots))
        return Layer.merge(islands(root, slots), forwards).pipe(Layer.provide(loops))
      })
    )
}
