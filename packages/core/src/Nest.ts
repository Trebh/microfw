import { Effect, Option, Schema, SchemaAST } from "effect"
import {
  type AnyDefinition,
  type Codec,
  intentKeyOf,
  type IntentOf,
  type ModelOf,
  type ProposalOf,
  type RepresentationOf,
  type SamDefinition,
  type ServicesOf,
  type Tagged
} from "./Definition.ts"

/** Wrapper tag of every child proposal and child intent in the nested definition. */
const CHILD_TAG = "Child"

export interface NestedModel<PD extends AnyDefinition, CD extends AnyDefinition> {
  readonly parent: ModelOf<PD>
  readonly child: ModelOf<CD>
}

export interface ChildProposal<CD extends AnyDefinition> {
  readonly _tag: "Child"
  readonly proposal: ProposalOf<CD>
}

export interface ChildIntent<CD extends AnyDefinition> {
  readonly _tag: "Child"
  readonly intent: IntentOf<CD>
}

export type NestedProposal<PD extends AnyDefinition, CD extends AnyDefinition> = ProposalOf<PD> | ChildProposal<CD>

export type NestedIntent<PD extends AnyDefinition, CD extends AnyDefinition> = IntentOf<PD> | ChildIntent<CD>

export interface NestedRepresentation<PD extends AnyDefinition, CD extends AnyDefinition, S extends string> {
  readonly controlState: S
  readonly parent: RepresentationOf<PD>
  readonly child: RepresentationOf<CD>
}

/** The definition `nest` returns: one model, one history and one graph for both sides. */
export type Nested<
  PD extends AnyDefinition,
  CD extends AnyDefinition,
  S extends string = RepresentationOf<PD>["controlState"]
> = SamDefinition<
  Codec<NestedModel<PD, CD>>,
  Codec<NestedProposal<PD, CD>>,
  Codec<NestedIntent<PD, CD>>,
  Codec<NestedRepresentation<PD, CD, S>>,
  ServicesOf<PD> | ServicesOf<CD>
>

/**
 * Proposal forwarding, applied inside the step that accepted the original proposal. Each direction
 * forwards at most one proposal, one hop: the forwarded proposal reaches the other side's acceptors
 * and is not forwarded back.
 */
export interface Forwarding<PD extends AnyDefinition, CD extends AnyDefinition> {
  /** Called with every accepted child proposal (unwrapped); `Some` is applied to the parent. */
  readonly toParent?: (proposal: ProposalOf<CD>) => Option.Option<ProposalOf<PD>>
  /** Called with every accepted parent proposal; `Some` is applied to the child. */
  readonly toChild?: (proposal: ProposalOf<PD>) => Option.Option<ProposalOf<CD>>
}

/** A control state computed from both sides; `controlStates` lists every value it can take. */
export interface CombinedControlState<PD extends AnyDefinition, CD extends AnyDefinition, S extends string> {
  readonly controlState: (parent: RepresentationOf<PD>, child: RepresentationOf<CD>) => S
  readonly controlStates: ReadonlyArray<S>
}

export type NestOptions<PD extends AnyDefinition, CD extends AnyDefinition, S extends string> =
  & Forwarding<PD, CD>
  & {
    /** Default: `${parent.name}/${child.name}`. Ports are keyed by name. */
    readonly name?: string
  }
  & (CombinedControlState<PD, CD, S> | { readonly controlState?: undefined; readonly controlStates?: undefined })

// What a definition erased to `AnyDefinition` holds; `nest` restores the precise types once, in its signature.
type Model = ModelOf<AnyDefinition>
type Proposal = ProposalOf<AnyDefinition>
type Representation = RepresentationOf<AnyDefinition>
type Acceptor = AnyDefinition["acceptors"][number]

interface LooseOptions {
  readonly name?: string | undefined
  readonly controlState?: ((parent: Representation, child: Representation) => string) | undefined
  readonly controlStates?: ReadonlyArray<string> | undefined
  readonly toParent?: ((proposal: Proposal) => Option.Option<Proposal>) | undefined
  readonly toChild?: ((proposal: Proposal) => Option.Option<Proposal>) | undefined
}

const isChild = (value: Tagged) => value._tag === CHILD_TAG

/** The `_tag` literals of a union of tagged structs; other shapes contribute none. */
const shapeTags = (type: SchemaAST.AST): ReadonlyArray<string> => {
  if (SchemaAST.isUnion(type)) return type.types.flatMap(shapeTags)
  if (!SchemaAST.isObjects(type)) return []
  const tag = type.propertySignatures.find((signature) => signature.name === "_tag")?.type
  return tag !== undefined && SchemaAST.isLiteral(tag) ? [String(tag.literal)] : []
}

/**
 * The tags a schema can carry on either side. A class (`Schema.TaggedClass`) is a declaration on
 * the type side and a struct only on the encoded side, so both are read.
 */
const tagsOf = (ast: SchemaAST.AST): ReadonlyArray<string> => [
  ...shapeTags(SchemaAST.toType(ast)),
  ...shapeTags(SchemaAST.toEncoded(ast))
]

const assertNoChildTag = (parent: AnyDefinition) => {
  const taken = [...tagsOf(parent.proposal.ast), ...tagsOf(parent.intent.ast)].includes(CHILD_TAG)
  if (taken) throw new Error(`mufw: nest: ${parent.name} already has a "${CHILD_TAG}" proposal or intent tag`)
}

const nestedSchemas = (parent: AnyDefinition, child: AnyDefinition, controlStates: ReadonlyArray<string>) => ({
  model: Schema.Struct({ parent: parent.model, child: child.model }),
  proposal: Schema.Union([parent.proposal, Schema.TaggedStruct(CHILD_TAG, { proposal: child.proposal })]),
  intent: Schema.Union([parent.intent, Schema.TaggedStruct(CHILD_TAG, { intent: child.intent })]),
  representation: Schema.Struct({
    controlState: Schema.Literals(controlStates),
    parent: parent.representation,
    child: child.representation
  })
})

const foldAcceptors = (acceptors: ReadonlyArray<Acceptor>, model: Model, proposal: Proposal) =>
  acceptors.reduce((current, accept) => accept(current, proposal), model)

const parentAcceptor = (accept: Acceptor): Acceptor => (model, proposal) =>
  isChild(proposal) ? model : { ...model, parent: accept(model.parent, proposal) }

const childAcceptor = (accept: Acceptor): Acceptor => (model, proposal) =>
  isChild(proposal) ? { ...model, child: accept(model.child, proposal.proposal) } : model

const forwardToChild = (child: AnyDefinition, toChild: NonNullable<LooseOptions["toChild"]>): Acceptor =>
(model, proposal) => {
  if (isChild(proposal)) return model
  return Option.match(toChild(proposal), {
    onNone: () => model,
    onSome: (forwarded) => ({ ...model, child: foldAcceptors(child.acceptors, model.child, forwarded) })
  })
}

const forwardToParent = (parent: AnyDefinition, toParent: NonNullable<LooseOptions["toParent"]>): Acceptor =>
(model, proposal) => {
  if (!isChild(proposal)) return model
  return Option.match(toParent(proposal.proposal), {
    onNone: () => model,
    onSome: (forwarded) => ({ ...model, parent: foldAcceptors(parent.acceptors, model.parent, forwarded) })
  })
}

/** Routed acceptors first, forwarding last: a forwarded proposal lands on a side that already took its own. */
const nestedAcceptors = (parent: AnyDefinition, child: AnyDefinition, options: LooseOptions): Array<Acceptor> => [
  ...parent.acceptors.map(parentAcceptor),
  ...child.acceptors.map(childAcceptor),
  ...(options.toParent === undefined ? [] : [forwardToParent(parent, options.toParent)]),
  ...(options.toChild === undefined ? [] : [forwardToChild(child, options.toChild)])
]

const nestedReactors = (parent: AnyDefinition, child: AnyDefinition) => [
  ...parent.reactors.map((react) => (model: Model) => ({ ...model, parent: react(model.parent) })),
  ...child.reactors.map((react) => (model: Model) => ({ ...model, child: react(model.child) }))
]

const nestedState = (parent: AnyDefinition, child: AnyDefinition, options: LooseOptions) => {
  const controlState = options.controlState ?? ((parentRepresentation: Representation) => parentRepresentation.controlState)
  return (model: Model) => {
    const parentRepresentation = parent.state(model.parent)
    const childRepresentation = child.state(model.child)
    return {
      controlState: controlState(parentRepresentation, childRepresentation),
      parent: parentRepresentation,
      child: childRepresentation
    }
  }
}

const nestedNap = (parent: AnyDefinition, child: AnyDefinition) => (representation: Representation) => {
  const own = parent.nap(representation.parent)
  if (Option.isSome(own)) return own
  return Option.map(child.nap(representation.child), (intent) => ({ _tag: CHILD_TAG, intent }))
}

/** A child intent is keyed under `Child/` plus the child's own key, so distinct child intents never block each other. */
const nestedIntentKey = (parent: AnyDefinition, child: AnyDefinition) => (intent: IntentOf<AnyDefinition>): string =>
  isChild(intent) ? `${CHILD_TAG}/${intentKeyOf(child, intent.intent)}` : intentKeyOf(parent, intent)

/** The intent was decoded against the child's schema, so its tag has an action. */
const childAction = (child: AnyDefinition) => (wrapper: ChildIntent<AnyDefinition>) =>
  Effect.map(child.actions[wrapper.intent._tag]!(wrapper.intent), (proposal) => ({ _tag: CHILD_TAG, proposal }))

const nestLoosely = (parent: AnyDefinition, child: AnyDefinition, options: LooseOptions): AnyDefinition => {
  assertNoChildTag(parent)
  const controlStates = options.controlStates ?? parent.controlStates
  return {
    name: options.name ?? `${parent.name}/${child.name}`,
    ...nestedSchemas(parent, child, controlStates),
    controlStates,
    initial: { parent: parent.initial, child: child.initial },
    acceptors: nestedAcceptors(parent, child, options),
    reactors: nestedReactors(parent, child),
    state: nestedState(parent, child, options),
    nap: nestedNap(parent, child),
    intentKey: nestedIntentKey(parent, child),
    actions: { ...parent.actions, [CHILD_TAG]: childAction(child) }
  }
}

const isTagged = (value: unknown): value is Tagged =>
  typeof value === "object" && value !== null && "_tag" in value && typeof value._tag === "string"

/** A plain definition may have its own `Child` tag with any payload, so only a wrapped tagged proposal is a child proposal. */
const isChildProposal = (value: Tagged): value is ChildProposal<AnyDefinition> =>
  isChild(value) && "proposal" in value && isTagged(value.proposal)

/** What a proposal is called in a history: its tag, or for a child proposal `Child/` and the inner label, recursively (`Child/Inc`). */
export const proposalLabel = (proposal: Tagged): string =>
  isChildProposal(proposal) ? `${CHILD_TAG}/${proposalLabel(proposal.proposal)}` : proposal._tag

/**
 * Composes `child` into `parent` as one definition, so one loop, one history and one graph cover
 * both (wizards, forms).
 *
 * - model `{ parent, child }`; the parent's proposals and intents keep their tags, the child's are
 *   wrapped as `{ _tag: "Child", proposal }` and `{ _tag: "Child", intent }`
 * - representation `{ controlState, parent, child }`; `controlState` is the parent's unless
 *   `options.controlState` combines both sides, in which case `options.controlStates` lists its values
 * - each acceptor and reactor sees only its own side's model; `nap` offers the parent's intent first,
 *   then the child's; a child intent runs the child's action and wraps the proposal it returns
 * - `toParent`/`toChild` forward an accepted proposal to the other side in the same step
 * - the services of the result are those of both definitions
 *
 * Throws when `parent` already has a `Child` proposal or intent tag.
 */
export const nest = <
  PD extends AnyDefinition,
  CD extends AnyDefinition,
  S extends string = RepresentationOf<PD>["controlState"]
>(
  parent: PD,
  child: CD,
  options?: NestOptions<PD, CD, S>
): Nested<PD, CD, S> =>
  // The loose definition's schemas are the nested ones; TypeScript cannot compose them over generic `PD`, `CD`.
  nestLoosely(parent, child, options ?? {}) as Nested<PD, CD, S>
