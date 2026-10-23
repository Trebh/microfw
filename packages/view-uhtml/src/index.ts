import type { AnyDefinition, DispatchRefused, IntentOf, Ports, RepresentationOf } from "@mufw/core"
import { Effect, FiberSet, Layer, Stream } from "effect"
import type { Hole } from "uhtml"

export { inputBudgetMillis, layerInputScheduler } from "./Scheduler.ts"

/** A pure view: representation in, template out; user events become intents through `dispatch`. */
export type View<Repr, Intent> = (representation: Repr, dispatch: (intent: Intent) => void) => Hole

export type Render = <T>(where: T, what: Hole | (() => Hole)) => T

export interface MountOptions<D extends AnyDefinition, R = never> {
  readonly root: Element
  readonly view: View<RepresentationOf<D>, IntentOf<D>>
  /** Default: uhtml's `render`, loaded on mount because uhtml needs a DOM at import time. */
  readonly render?: Render
  /**
   * Where a dispatch the intent port refused goes. The view only emits intents, so the refusal
   * reaches the page through this effect (a notice service), not through the representation.
   */
  readonly onRefused: (refused: DispatchRefused) => Effect.Effect<void, never, R>
}

const defaultRender = Effect.promise(() => import("uhtml")).pipe(Effect.map((uhtml): Render => uhtml.render))

/** Re-renders `view` into `root` on every representation. Requires `IntentPort | ModelPort` and what `onRefused` requires. */
export const layerMount = <D extends AnyDefinition, R = never>(ports: Ports<D>, options: MountOptions<D, R>) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const intents = yield* ports.IntentPort
      const model = yield* ports.ModelPort
      const render = options.render ?? (yield* defaultRender)
      const runFork = yield* FiberSet.makeRuntime<R>()
      const dispatch = (intent: IntentOf<D>) => {
        runFork(intents.dispatch(intent).pipe(Effect.catchTag("DispatchRefused", options.onRefused)))
      }
      const paint = (representation: RepresentationOf<D>) =>
        Effect.sync(() => render(options.root, options.view(representation, dispatch)))
      yield* Effect.forkScoped(Stream.runForEach(model.representations, paint))
    })
  )

export interface ReadOnlyMountOptions<D extends AnyDefinition> {
  readonly root: Element
  readonly view: (representation: RepresentationOf<D>) => Hole
  /** Default: uhtml's `render`, loaded on mount because uhtml needs a DOM at import time. */
  readonly render?: Render
}

/**
 * Re-renders `view` into `root` on every representation. It requires `ModelPort` alone and the view
 * is given no `dispatch`, so an island mounted with it cannot send an intent and needs no
 * `IntentPort`: a model read from a source that only serves representations is enough.
 */
export const layerMountReadOnly = <D extends AnyDefinition>(ports: Ports<D>, options: ReadOnlyMountOptions<D>) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const model = yield* ports.ModelPort
      const render = options.render ?? (yield* defaultRender)
      const paint = (representation: RepresentationOf<D>) =>
        Effect.sync(() => render(options.root, options.view(representation)))
      yield* Effect.forkScoped(Stream.runForEach(model.representations, paint))
    })
  )
