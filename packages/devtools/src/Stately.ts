import { type AnyDefinition, type Ports, proposalLabel, type StepRecord, type XStateDefinition } from "@mufw/core"
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

/** A `StatelyInspector` that can be started; `createBrowserInspector({ autoStart: false })` is one. */
export interface StartableInspector extends StatelyInspector {
  start(): void
}

type Registration = Parameters<StatelyInspector["actor"]>
type Update = Parameters<StatelyInspector["snapshot"]>

export interface StatelyOptions {
  /** Usually `toXStateDefinition(def, exploreGraph(def, explore))`. */
  readonly definition: XStateDefinition
}

/**
 * Wraps an inspector that buffers events until `start()`, remembering the actor registration and
 * the latest snapshot. Starting re-sends both: the buffer is bounded, so on a long session it
 * has dropped the registration and the inspector would draw nothing.
 */
export const replayOnStart = (inspector: StartableInspector): StartableInspector => {
  let registration: Registration | undefined
  let latest: Update | undefined
  return {
    actor: (...args) => {
      registration = args
      inspector.actor(...args)
    },
    event: (actor, event) => inspector.event(actor, event),
    snapshot: (...args) => {
      latest = args
      inspector.snapshot(...args)
    },
    start: () => {
      inspector.start()
      if (registration !== undefined) inspector.actor(...registration)
      if (latest !== undefined) inspector.snapshot(...latest)
    }
  }
}

const TRAVEL_EVENT: InspectedEvent = { type: "@mufw.travel" }
const RESTORE_EVENT: InspectedEvent = { type: "@mufw.restore" }

/**
 * Mirrors the history into a Stately inspector: `init` registers the actor, a step sends its
 * proposal as the event and the new control state as the snapshot value, a travel or a restore sends a snapshot.
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
          if (record.kind === "restore") return inspector.snapshot(def.name, snapshot, { event: RESTORE_EVENT })
          if (Option.isNone(record.proposal)) return inspector.snapshot(def.name, snapshot, { event: TRAVEL_EVENT })
          const type = proposalLabel(def, record.proposal.value)
          inspector.event(def.name, { ...record.proposal.value, type })
          inspector.snapshot(def.name, snapshot, { event: { type } })
        })
      yield* Effect.forkScoped(Stream.runForEach(history.records, forward))
    })
  )
