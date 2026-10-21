import type { AnyDefinition, Ports, StepRecord, XStateDefinition } from "@mufw/core"
import { Effect, Layer, Option, Stream } from "effect"

export interface InspectedSnapshot {
  readonly context: unknown
  readonly value: string
}

export interface InspectedEvent {
  readonly type: string
}

/** The inspector's `actor()` reads the state diagram only from an actor ref's `logic.config`. */
export interface InspectedActor {
  readonly sessionId: string
  readonly logic: { readonly config: XStateDefinition }
  send(event: unknown): void
  getSnapshot(): unknown
}

/**
 * The manual API of a `@statelyai/inspect` inspector (which does not export its type);
 * `createBrowserInspector()` and `createInspector(adapter)` both satisfy it.
 */
export interface StatelyInspector {
  actor(actor: InspectedActor, snapshot?: InspectedSnapshot): void
  event(actor: string, event: InspectedEvent): void
  snapshot(actor: string, snapshot: InspectedSnapshot, info?: { readonly event?: InspectedEvent }): void
}

export interface StatelyOptions {
  /** Usually `toXStateDefinition(def, exploreGraph(def, explore))`. */
  readonly definition: XStateDefinition
}

const TRAVEL_EVENT: InspectedEvent = { type: "@mufw.travel" }

/**
 * Mirrors the history into a Stately inspector: `init` registers the actor, a step sends its
 * proposal as the event and the new control state as the snapshot value, a travel sends a snapshot.
 */
export const layerStately = <D extends AnyDefinition>(
  def: D,
  ports: Ports<D>,
  inspector: StatelyInspector,
  options: StatelyOptions
) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const history = yield* ports.HistoryPort
      const actorRef: InspectedActor = {
        sessionId: def.name,
        logic: { config: options.definition },
        send: () => {},
        getSnapshot: () => undefined
      }
      const forward = (record: StepRecord<D>) =>
        Effect.sync(() => {
          const snapshot = { context: record.model, value: record.representation.controlState }
          if (record.kind === "init") return inspector.actor(actorRef, snapshot)
          if (Option.isNone(record.proposal)) return inspector.snapshot(def.name, snapshot, { event: TRAVEL_EVENT })
          const type: string = record.proposal.value._tag
          inspector.event(def.name, { ...record.proposal.value, type })
          inspector.snapshot(def.name, snapshot, { event: { type } })
        })
      yield* Effect.forkScoped(Stream.runForEach(history.records, forward))
    })
  )
