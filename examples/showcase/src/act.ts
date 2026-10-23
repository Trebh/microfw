import type { Layer } from "effect"

/** One beat of an act: a surtitle line and where the spotlight falls while it is up. */
export interface Cue {
  /** The surtitle shown while the cue is up. Stage directions go in square brackets. */
  readonly line: string
  /** The `data-spot` value of the element the spotlight falls on, inside the act's root; `null` lights the whole stage. */
  readonly spot: string | null
}

/** What the playbill and the deck know about an act; the act's island is separate, in `Act.layer`. */
export interface ActScript {
  /** Lower-case and url-safe; the act's root element is `#act-<id>` and its location hash `#<id>`. */
  readonly id: string
  /** The act's roman numeral ("I", "II"…), or "" for the overture and the finale. */
  readonly numeral: string
  readonly title: string
  readonly subtitle: string
  /** The µFW feature the act performs, named by its API (`layerLoopLocal · applyProposal`). */
  readonly feature: string
  /** At least one. */
  readonly cues: ReadonlyArray<Cue>
}

/**
 * An act of the presentation: its script, and its island, mounted into `root` for the life of the
 * page. `R` is what the composition root provides it: the shared stage's ports, the deck's ports, a
 * domain service adapter.
 */
export interface Act<R = never> {
  readonly script: ActScript
  readonly layer: (root: HTMLElement) => Layer.Layer<never, never, R>
}
