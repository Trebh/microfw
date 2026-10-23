import { type Forward, type IntentPort, layerForward, layerLoopLocal, type ModelPort } from "@mufw/core"
import { layerMount, layerMountReadOnly } from "@mufw/view-uhtml"
import { Effect, Layer, Option, Stream } from "effect"
import { render } from "uhtml"
import { type Deck, DeckPorts, type Representation as DeckRepresentation } from "../../deck/Deck.ts"
import type { BoxOffice } from "../../domain/BoxOffice.ts"
import { Connection, type ConnectionState } from "./connection.ts"
import { audienceOf, layerOpenDoors, layerStopwatch } from "./doors.ts"
import { type Meter, meterFor } from "./Meter.ts"
import { meterView } from "./meterView.ts"
import { script } from "./script.ts"
import { seatMap } from "./seatMap.ts"
import type { Stage } from "./stages.ts"

/** Where one stage paints: its seat map, its stopwatch, and the lamp that says whether it is up. */
export interface Mounts {
  readonly seats: HTMLElement
  readonly meter: HTMLElement
  readonly lamp: HTMLElement
}

/** A placement: the stage's three ports, from wherever the loop behind them runs. */
export type Placement = Layer.Layer<IntentPort<typeof BoxOffice> | ModelPort<typeof BoxOffice>>

const metersCue = script.cues.findIndex((cue) => cue.spot === "meters")

const isMetersCue = (representation: DeckRepresentation): boolean =>
  representation.actId === script.id && representation.cue === metersCue

/** When the meters come up, the stage manager presses a seat on every stage, through the audience's door. */
const holdWhenMetersComeUp: Forward<typeof Deck, typeof BoxOffice> = (previous, current) =>
  isMetersCue(current) && !Option.exists(previous, isMetersCue)
    ? Option.some({ _tag: "Hold", seat: "B3" } as const)
    : Option.none()

/** Every representation of a stage tells its stopwatch which seats it shows taken. */
const observed: Forward<typeof BoxOffice, typeof Meter> = (_previous, current) =>
  Option.some(
    {
      _tag: "Observe",
      taken: current.seats.filter((seat) => seat.status !== "free").map((seat) => seat.id)
    } as const
  )

const LAMP_TEXT: Readonly<Record<ConnectionState, string>> = {
  connecting: "waking",
  connected: "live",
  disconnected: "lost"
}

const layerLamp = (lamp: HTMLElement) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const states = yield* Connection
      const show = (state: ConnectionState) =>
        Effect.sync(() => {
          lamp.dataset.state = state
          lamp.textContent = LAMP_TEXT[state]
        })
      yield* Effect.forkScoped(Stream.runForEach(states, show))
    })
  )

/**
 * One stage of the tour, whatever its placement: the same seat map and the same stopwatch around
 * ports that come from `placement`. The seat map is mounted on the audience's door, which times a
 * hold on its way to the stage; the stopwatch follows the stage's own representations.
 */
export const island = (stage: Stage, placement: Placement, mounts: Mounts) => {
  const audience = audienceOf(stage)
  const meter = meterFor(stage.def.name)
  const audienceSide = Layer.mergeAll(
    layerMount(audience, {
      root: mounts.seats,
      view: seatMap,
      render,
      onRefused: (refused) => Effect.logWarning(refused)
    }),
    layerForward(DeckPorts, audience, holdWhenMetersComeUp)
  ).pipe(Layer.provide(layerStopwatch(stage, audience, meter)))
  const stageSide = Layer.mergeAll(
    layerForward(stage.ports, meter.ports, observed),
    layerMountReadOnly(meter.ports, { root: mounts.meter, view: meterView, render }),
    layerLamp(mounts.lamp),
    layerOpenDoors(stage)
  )
  return Layer.merge(audienceSide, stageSide).pipe(
    Layer.provide(Layer.merge(layerLoopLocal(meter.def, meter.ports), placement))
  )
}
