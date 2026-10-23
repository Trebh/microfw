import type { StepRecord } from "@mufw/core"
import { Effect, Layer, Stream } from "effect"
import { Deck, DeckPorts } from "./Deck.ts"

const rewoundIntoAutoplay = (record: StepRecord<typeof Deck>) => record.kind === "travel" && record.representation.autoplay

/**
 * Travelling interrupts the prompter's reading in flight, and a travel runs no `nap`, so a model
 * restored with autoplay on would claim a show that nobody is running. The deck records the
 * interruption as a step of its own, which the book shows right after the rewind.
 */
export const layerInterruption = Layer.effectDiscard(
  Effect.gen(function*() {
    const history = yield* DeckPorts.HistoryPort
    const intents = yield* DeckPorts.IntentPort
    const interrupt = intents.dispatch({ _tag: "Interrupt" }).pipe(
      Effect.catchTag("DispatchRefused", (refused) => Effect.logWarning(refused))
    )
    const interruptions = history.records.pipe(Stream.filter(rewoundIntoAutoplay), Stream.runForEach(() => interrupt))
    yield* Effect.forkScoped(interruptions)
  })
)
