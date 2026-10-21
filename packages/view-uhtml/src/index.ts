import type { AnyDefinition, IntentOf, Ports, RepresentationOf } from "@mufw/core"
import { Effect, Layer, Stream } from "effect"
import type { Hole } from "uhtml"

/** A pure view: representation in, template out; user events become intents through `dispatch`. */
export type View<Repr, Intent> = (representation: Repr, dispatch: (intent: Intent) => void) => Hole

export type Render = <T>(where: T, what: Hole | (() => Hole)) => T

export interface MountOptions<D extends AnyDefinition> {
  readonly root: Element
  readonly view: View<RepresentationOf<D>, IntentOf<D>>
  /** Default: uhtml's `render`, loaded on mount because uhtml needs a DOM at import time. */
  readonly render?: Render
}

const defaultRender = Effect.promise(() => import("uhtml")).pipe(Effect.map((uhtml): Render => uhtml.render))

/** Re-renders `view` into `root` on every representation. Requires `IntentBus | ModelPort`. */
export const layerMount = <D extends AnyDefinition>(ports: Ports<D>, options: MountOptions<D>) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const bus = yield* ports.IntentBus
      const model = yield* ports.ModelPort
      const render = options.render ?? (yield* defaultRender)
      const dispatch = (intent: IntentOf<D>) => {
        Effect.runFork(bus.dispatch(intent))
      }
      const paint = (representation: RepresentationOf<D>) =>
        Effect.sync(() => render(options.root, options.view(representation, dispatch)))
      yield* Effect.forkScoped(Stream.runForEach(model.representations, paint))
    })
  )
