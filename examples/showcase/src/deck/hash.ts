import { Effect, FiberSet, Layer, Stream } from "effect"
import { DeckPorts } from "./Deck.ts"

/**
 * Keeps `location.hash` on the act the deck is on, and takes the deck to the act a hand-edited hash
 * names. The hash is replaced, not pushed: the back button leaves the show instead of stepping through it.
 */
export const layerHash = Layer.effectDiscard(
  Effect.gen(function*() {
    const model = yield* DeckPorts.ModelPort
    const intents = yield* DeckPorts.IntentPort
    const runFork = yield* FiberSet.makeRuntime()

    const goToHashedAct = () => {
      const actId = location.hash.slice(1)
      runFork(
        intents.dispatch({ _tag: "GoTo", actId, cue: 0 }).pipe(
          Effect.catchTag("DispatchRefused", (refused) => Effect.logWarning(refused))
        )
      )
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => window.addEventListener("hashchange", goToHashedAct)),
      () => Effect.sync(() => window.removeEventListener("hashchange", goToHashedAct))
    )

    const writeHash = (actId: string) => Effect.sync(() => history.replaceState(null, "", `#${actId}`))
    const hashes = model.representations.pipe(
      Stream.map((representation) => representation.actId),
      Stream.changes,
      Stream.runForEach(writeHash)
    )
    yield* Effect.forkScoped(hashes)
  })
)
