import type { Effect } from "effect"
import { Option, Schema } from "effect"

/** The part of every representation µFW relies on: SAM's control state. */
export interface Representation {
  readonly controlState: string
}

/** Proposals and intents are discriminated by `_tag`. */
export interface Tagged {
  readonly _tag: string
}

/** The member of a tagged union `U` whose tag is `T`: the proposal an acceptor or the intent an action receives. */
export type WithTag<U extends Tagged, T extends U["_tag"]> = Extract<U, { readonly _tag: T }>

/** A technical failure of an action. Business rejections are proposals, not failures. */
export class ActionFailure extends Schema.TaggedError<ActionFailure>()("ActionFailure", {
  intentTag: Schema.String,
  message: Schema.String
}) {}

/** Schemas cross the wire, so they cannot require services to encode or decode. */
export type Codec<T> = Schema.Codec<T, any>

export type Actions<I extends Tagged, P, R> = {
  readonly [T in I["_tag"]]: (intent: WithTag<I, T>) => Effect.Effect<P, ActionFailure, R>
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

/** One acceptor per proposal tag: the compiler rejects a missing or an unknown tag. */
export type Acceptors<M, P extends Tagged> = {
  readonly [T in P["_tag"]]: (model: M, proposal: WithTag<P, T>) => M
}

/** One entry per control state: the compiler rejects a missing or an unknown control state. */
export type Nap<Rp extends Representation, I> = {
  readonly [S in Rp["controlState"]]: (representation: Rp) => Option.Option<I>
}

/** A proposal tag a definition accepts and ignores. */
export const unchanged = <M>(model: M): M => model

/** A control state with no automatic intent. */
export const noIntent = (): Option.Option<never> => Option.none()

/** What the author writes. Everything but the actions is pure. */
export interface SamBehaviour<
  M extends Codec<any>,
  P extends Codec<Tagged>,
  I extends Codec<Tagged>,
  Rp extends Codec<Representation>,
  R
> {
  readonly initial: M["Type"]
  readonly acceptors: Acceptors<M["Type"], P["Type"]>
  readonly reactors: ReadonlyArray<(model: M["Type"]) => M["Type"]>
  readonly state: (model: M["Type"]) => Rp["Type"]
  readonly nap: Nap<Rp["Type"], I["Type"]>
  /**
   * Automatic intents with the same key are not run concurrently: while one is in flight the drain
   * skips the others. Default: the intent's `_tag`. Pure.
   */
  intentKey?(intent: I["Type"]): string
  readonly actions: Actions<I["Type"], P["Type"], R>
}

/** What `define` compiles and every consumer reads: the control states and the acceptors as lists, `nap` as one function. */
export interface SamDefinition<
  M extends Codec<any>,
  P extends Codec<Tagged>,
  I extends Codec<Tagged>,
  Rp extends Codec<Representation>,
  R
> extends SamSchemas<M, P, I, Rp> {
  readonly controlStates: ReadonlyArray<string>
  readonly initial: M["Type"]
  readonly acceptors: ReadonlyArray<(model: M["Type"], proposal: P["Type"]) => M["Type"]>
  readonly reactors: ReadonlyArray<(model: M["Type"]) => M["Type"]>
  readonly state: (model: M["Type"]) => Rp["Type"]
  readonly nap: (representation: Rp["Type"]) => Option.Option<I["Type"]>
  intentKey?(intent: I["Type"]): string
  readonly actions: Actions<I["Type"], P["Type"], R>
}

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
 * One acceptor per key, in key order; each sees only the proposals of its own tag. The cast widens
 * each record entry's proposal type from its own tag to `P`, which the tag test makes sound.
 */
const compileAcceptors = <M, P extends Tagged>(
  acceptors: Acceptors<M, P>
): ReadonlyArray<(model: M, proposal: P) => M> => {
  const entries = Object.entries(acceptors) as unknown as ReadonlyArray<readonly [string, (model: M, proposal: P) => M]>
  return entries.map(([tag, accept]) => (model, proposal) => proposal._tag === tag ? accept(model, proposal) : model)
}

/** The `nap` record as one function that looks the representation's control state up. */
const compileNap = <Rp extends Representation, I>(nap: Nap<Rp, I>) => (representation: Rp): Option.Option<I> =>
  nap[representation.controlState as Rp["controlState"]](representation)

/**
 * `define(schemas)(behaviour)`. Two calls, because TypeScript only types the behaviour's literals
 * (the acceptor keys from the proposal's `_tag`s, the `nap` keys from the representation's control
 * states) from the schemas once the schemas are fixed by the first call. The control states of the
 * definition are the keys of `nap`, in key order.
 */
export const define =
  <M extends Codec<any>, P extends Codec<Tagged>, I extends Codec<Tagged>, Rp extends Codec<Representation>>(
    schemas: SamSchemas<M, P, I, Rp>
  ) =>
  <R = never>(behaviour: SamBehaviour<M, P, I, Rp, R>): SamDefinition<M, P, I, Rp, R> => ({
    ...schemas,
    ...behaviour,
    controlStates: Object.keys(behaviour.nap),
    acceptors: compileAcceptors(behaviour.acceptors),
    nap: compileNap(behaviour.nap)
  })
