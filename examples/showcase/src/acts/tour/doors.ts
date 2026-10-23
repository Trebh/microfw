import type { IntentPort, IntentPortShape, Ports } from "@mufw/core"
import { Context, Effect, Layer } from "effect"
import type { BoxOffice } from "../../domain/BoxOffice.ts"
import type { StageMeter } from "./Meter.ts"
import type { Stage } from "./stages.ts"

type Door = IntentPortShape<typeof BoxOffice>

/**
 * The keys the audience's seat map is mounted on: the stage's own, except its intent port. That
 * one is the metered door, so what the audience presses is timed and the loop behind it is not told.
 */
export const audienceOf = (stage: Stage): Ports<typeof BoxOffice> => ({
  ...stage.ports,
  IntentPort: Context.Service<IntentPort<typeof BoxOffice>, Door>(`${stage.def.name}/Audience/IntentPort`)
})

/**
 * The audience's door: a hold queues the stage's stopwatch before it goes through the stage's own
 * door, so the stopwatch's action, which reads the clock, starts before the stage can answer.
 */
export const layerStopwatch = (stage: Stage, audience: Ports<typeof BoxOffice>, meter: StageMeter) =>
  Layer.effect(
    audience.IntentPort,
    Effect.gen(function*() {
      const door = yield* stage.ports.IntentPort
      const stopwatch = yield* meter.ports.IntentPort
      const dispatch: Door["dispatch"] = (intent) =>
        intent._tag === "Hold"
          ? Effect.andThen(stopwatch.dispatch({ _tag: "Start", seat: intent.seat }), door.dispatch(intent))
          : door.dispatch(intent)
      return { dispatch }
    })
  )

/** A network that is not there: every intent waits `millis` before it goes through the stage's door. */
export const layerLatency = (stage: Stage, millis: number) =>
  Layer.effect(
    stage.ports.IntentPort,
    stage.ports.IntentPort.useSync((door): Door => ({
      dispatch: (intent) => Effect.sleep(millis).pipe(Effect.andThen(door.dispatch(intent)))
    }))
  )

/** The doors open when the act is built, through the stage's own door, wherever the stage runs. */
export const layerOpenDoors = (stage: Stage) =>
  Layer.effectDiscard(
    stage.ports.IntentPort.use((door) => door.dispatch({ _tag: "OpenDoors" })).pipe(
      Effect.catchCause((cause) => Effect.logWarning(`${stage.def.name}: the doors would not open`, cause)),
      Effect.forkScoped
    )
  )
