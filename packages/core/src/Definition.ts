import type { Effect, Option } from "effect"
import { Schema } from "effect"

/** The part of every representation µFW relies on: SAM's control state. */
export interface Representation {
  readonly controlState: string
}

/** Proposals and intents are discriminated by `_tag`. */
export interface Tagged {
  readonly _tag: string
}

/** A technical failure of an action. Business rejections are proposals, not failures. */
export class ActionFailure extends Schema.TaggedError<ActionFailure>()("ActionFailure", {
  intentTag: Schema.String,
  message: Schema.String
}) {}

/** Schemas cross the wire, so they cannot require services to encode or decode. */
export type Codec<T> = Schema.Codec<T, any>

export type Actions<I extends Tagged, P, R> = {
  readonly [T in I["_tag"]]: (intent: Extract<I, { readonly _tag: T }>) => Effect.Effect<P, ActionFailure, R>
}

/** Every cut point of the SAM loop is a schema, so it can cross the wire and be recorded. */
export interface SamSchemas<
  M extends Codec<any>,
  P extends Codec<Tagged>,
  I extends Codec<Tagged>,
  Rp extends Codec<Representation>
> {
  readonly name: string
  readonly model: M
  readonly proposal: P
  readonly intent: I
  readonly representation: Rp
}

/** Everything but the actions is pure. */
export interface SamBehaviour<
  M extends Codec<any>,
  P extends Codec<Tagged>,
  I extends Codec<Tagged>,
  Rp extends Codec<Representation>,
  R
> {
  readonly controlStates: ReadonlyArray<string>
  readonly initial: M["Type"]
  readonly acceptors: ReadonlyArray<(model: M["Type"], proposal: P["Type"]) => M["Type"]>
  readonly reactors: ReadonlyArray<(model: M["Type"]) => M["Type"]>
  readonly state: (model: M["Type"]) => Rp["Type"]
  readonly nap: (representation: Rp["Type"]) => Option.Option<I["Type"]>
  /**
   * Automatic intents with the same key are not run concurrently: while one is in flight the drain
   * skips the others. Default: the intent's `_tag`. Pure.
   */
  intentKey?(intent: I["Type"]): string
  readonly actions: Actions<I["Type"], P["Type"], R>
}

export interface SamDefinition<
  M extends Codec<any>,
  P extends Codec<Tagged>,
  I extends Codec<Tagged>,
  Rp extends Codec<Representation>,
  R
> extends SamSchemas<M, P, I, Rp>, SamBehaviour<M, P, I, Rp, R> {}

export type AnyDefinition = SamDefinition<Codec<any>, Codec<any>, Codec<any>, Codec<any>, any>

export type ModelOf<D extends AnyDefinition> = D["model"]["Type"]
export type ProposalOf<D extends AnyDefinition> = D["proposal"]["Type"]
export type IntentOf<D extends AnyDefinition> = D["intent"]["Type"]
export type RepresentationOf<D extends AnyDefinition> = D["representation"]["Type"]
export type ServicesOf<D extends AnyDefinition> = D extends SamDefinition<any, any, any, any, infer R> ? R : never

/** The concurrency key of an automatic intent: the definition's `intentKey`, else the intent's tag. */
export const intentKeyOf = (definition: AnyDefinition, intent: Tagged): string =>
  definition.intentKey?.(intent) ?? intent._tag

/**
 * `define(schemas)(behaviour)`. Two calls, because TypeScript only types the behaviour's literals
 * (`_tag`s, control states) from the schemas once the schemas are fixed by the first call.
 */
export const define =
  <M extends Codec<any>, P extends Codec<Tagged>, I extends Codec<Tagged>, Rp extends Codec<Representation>>(
    schemas: SamSchemas<M, P, I, Rp>
  ) =>
  <R = never>(behaviour: SamBehaviour<M, P, I, Rp, R>): SamDefinition<M, P, I, Rp, R> => ({
    ...schemas,
    ...behaviour
  })
