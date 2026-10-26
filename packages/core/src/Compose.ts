import { Effect, Option, Schema } from "effect"
import {
  type AnyDefinition,
  type Codec,
  intentKeyOf,
  type IntentOf,
  type ModelOf,
  type ProposalOf,
  proposalLabel,
  type RepresentationOf,
  type SamDefinition,
  type ServicesOf,
  type Tagged
} from "./Definition.ts"
import { tagsOf } from "./Tags.ts"

/** A part name is a wire tag. */
const PART_NAME = /^[A-Z][A-Za-z0-9]*$/

/** Hooks of a slot; the proposal is all they see. */
export interface SlotHooks<PD extends AnyDefinition, CD extends AnyDefinition> {
  /** Called with every accepted proposal of the slot (unwrapped); `Some` is applied to the parent. */
  readonly toParent?: (proposal: ProposalOf<CD>) => Option.Option<ProposalOf<PD>>
  /** Called with every accepted parent proposal; `Some` is applied to the slot. */
  readonly fromParent?: (proposal: ProposalOf<PD>) => Option.Option<ProposalOf<CD>>
}

/** Hooks of a collection; they also receive the key of the instance they concern. */
export interface CollectionHooks<PD extends AnyDefinition, CD extends AnyDefinition> {
  /** Called with every proposal accepted by a held instance (unwrapped) and its key; `Some` is applied to the parent. */
  readonly toParent?: (proposal: ProposalOf<CD>, key: string) => Option.Option<ProposalOf<PD>>
  /** Called with every accepted parent proposal for each instance and its key; `Some` is applied to that instance. */
  readonly fromParent?: (proposal: ProposalOf<PD>, key: string) => Option.Option<ProposalOf<CD>>
}

export interface CollectionOptions<PD extends AnyDefinition, CD extends AnyDefinition>
  extends CollectionHooks<PD, CD>
{
  /** The keys of the instances, in order, read from the parent's model. A repeated key counts once. */
  readonly keys: (parent: ModelOf<PD>) => ReadonlyArray<string>
  /** The model of an instance whose key just appeared in `keys`. Default: the child's `initial`. */
  readonly create?: (key: string, parent: ModelOf<PD>) => ModelOf<CD>
}

/** One instance of a child definition. */
export interface SlotPart<PD extends AnyDefinition, CD extends AnyDefinition> extends SlotHooks<PD, CD> {
  readonly kind: "slot"
  readonly child: CD
}

/** An ordered, keyed, runtime-sized set of instances of one child definition; the parent owns which exist. */
export interface CollectionPart<PD extends AnyDefinition, CD extends AnyDefinition>
  extends CollectionOptions<PD, CD>
{
  readonly kind: "collection"
  readonly child: CD
}

/** What `compose` hands to its parts callback; the hooks it builds are typed from the parent. */
export interface PartBuilder<PD extends AnyDefinition> {
  readonly slot: <CD extends AnyDefinition>(child: CD, hooks?: SlotHooks<PD, CD>) => SlotPart<PD, CD>
  readonly collection: <CD extends AnyDefinition>(
    child: CD,
    options: CollectionOptions<PD, CD>
  ) => CollectionPart<PD, CD>
}

export type AnyPart = SlotPart<AnyDefinition, AnyDefinition> | CollectionPart<AnyDefinition, AnyDefinition>

/** The parts of a composition, by name. */
export type AnyParts = Readonly<Record<string, AnyPart>>

type ChildOf<P> = P extends { readonly child: infer CD extends AnyDefinition } ? CD : never

/** The model of a slot is its child's; a collection's is its instances in order. */
export type PartModel<P extends AnyPart> = P extends { readonly kind: "collection" }
  ? ReadonlyArray<{ readonly key: string; readonly model: ModelOf<ChildOf<P>> }>
  : ModelOf<ChildOf<P>>

export type PartRepresentation<P extends AnyPart> = P extends { readonly kind: "collection" }
  ? ReadonlyArray<{ readonly key: string; readonly representation: RepresentationOf<ChildOf<P>> }>
  : RepresentationOf<ChildOf<P>>

/** A slot's proposal is `{ _tag: Name, proposal }`; a collection's also names the instance: `{ _tag: Name, key, proposal }`. */
export type PartProposal<N extends string, P extends AnyPart> = P extends { readonly kind: "collection" }
  ? { readonly _tag: N; readonly key: string; readonly proposal: ProposalOf<ChildOf<P>> }
  : { readonly _tag: N; readonly proposal: ProposalOf<ChildOf<P>> }

export type PartIntent<N extends string, P extends AnyPart> = P extends { readonly kind: "collection" }
  ? { readonly _tag: N; readonly key: string; readonly intent: IntentOf<ChildOf<P>> }
  : { readonly _tag: N; readonly intent: IntentOf<ChildOf<P>> }

export interface ComposedModel<PD extends AnyDefinition, Parts extends AnyParts> {
  readonly parent: ModelOf<PD>
  readonly parts: { readonly [N in keyof Parts]: PartModel<Parts[N]> }
}

export type ComposedProposal<PD extends AnyDefinition, Parts extends AnyParts> =
  | ProposalOf<PD>
  | { [N in keyof Parts & string]: PartProposal<N, Parts[N]> }[keyof Parts & string]

export type ComposedIntent<PD extends AnyDefinition, Parts extends AnyParts> =
  | IntentOf<PD>
  | { [N in keyof Parts & string]: PartIntent<N, Parts[N]> }[keyof Parts & string]

/** The representation without its control state: what `options.controlState` combines. */
export interface ComposedRest<PD extends AnyDefinition, Parts extends AnyParts> {
  readonly parent: RepresentationOf<PD>
  readonly parts: { readonly [N in keyof Parts]: PartRepresentation<Parts[N]> }
}

export interface ComposedRepresentation<PD extends AnyDefinition, Parts extends AnyParts, S extends string>
  extends ComposedRest<PD, Parts>
{
  readonly controlState: S
}

type PartServices<Parts extends AnyParts> = ServicesOf<ChildOf<Parts[keyof Parts]>>

/** The definition `compose` returns: one model, one history and one graph for the parent and every part. */
export type Composed<
  PD extends AnyDefinition,
  Parts extends AnyParts,
  S extends string = RepresentationOf<PD>["controlState"]
> = SamDefinition<
  Codec<ComposedModel<PD, Parts>>,
  Codec<ComposedProposal<PD, Parts>>,
  Codec<ComposedIntent<PD, Parts>>,
  Codec<ComposedRepresentation<PD, Parts, S>>,
  ServicesOf<PD> | PartServices<Parts>
>

/** A control state computed from the parent and every part; `controlStates` lists every value it can take. */
export interface ComposedControlState<PD extends AnyDefinition, Parts extends AnyParts, S extends string> {
  readonly controlState: (rest: ComposedRest<PD, Parts>) => S
  readonly controlStates: ReadonlyArray<S>
}

export type ComposeOptions<PD extends AnyDefinition, Parts extends AnyParts, S extends string> =
  & {
    /** Default: `${parent.name}/${part names joined by "+"}`. Ports are keyed by name. */
    readonly name?: string
  }
  & (ComposedControlState<PD, Parts, S> | { readonly controlState?: undefined; readonly controlStates?: undefined })

// What a definition erased to `AnyDefinition` holds; `compose` restores the precise types once, in its signature.
type Model = ModelOf<AnyDefinition>
type Proposal = ProposalOf<AnyDefinition>
type Intent = IntentOf<AnyDefinition>
type Representation = RepresentationOf<AnyDefinition>
type Acceptor = AnyDefinition["acceptors"][number]
type Reactor = AnyDefinition["reactors"][number]
type Action = AnyDefinition["actions"][string]

interface LooseOptions {
  readonly name?: string | undefined
  readonly controlState?: ((rest: { readonly parent: Representation; readonly parts: Representation }) => string) | undefined
  readonly controlStates?: ReadonlyArray<string> | undefined
}

interface Instance {
  readonly key: string
  readonly model: Model
}

/**
 * What `compose` needs of a part, whatever its kind. A part's value is the slot's model or the
 * collection's instances; a wrapper is the part's wire proposal or intent.
 */
interface PartRuntime {
  readonly name: string
  readonly schemas: {
    readonly model: Codec<any>
    readonly representation: Codec<any>
    readonly proposal: Codec<any>
    readonly intent: Codec<any>
  }
  readonly initial: (parent: Model) => Model
  readonly accept: (value: Model, wrapper: Proposal) => Model
  readonly react?: ((value: Model) => Model) | undefined
  readonly reconcile?: ((value: Model, parent: Model) => Model) | undefined
  readonly forwardUp?: ((value: Model, wrapper: Proposal) => Option.Option<Proposal>) | undefined
  readonly forwardDown?: ((value: Model, proposal: Proposal) => Model) | undefined
  readonly state: (value: Model) => Representation
  readonly nap: (representation: Representation) => ReadonlyArray<Tagged>
  readonly intentKey: (wrapper: Intent) => string
  readonly action: Action
  readonly label: (wrapper: Proposal) => string
}

const foldAcceptors = (acceptors: ReadonlyArray<Acceptor>, model: Model, proposal: Proposal) =>
  acceptors.reduce((current, accept) => accept(current, proposal), model)

const foldReactors = (reactors: ReadonlyArray<Reactor>): ((model: Model) => Model) | undefined =>
  reactors.length === 0 ? undefined : (model) => reactors.reduce((current, react) => react(current), model)

/** The intent was decoded against the child's schema, so its tag has an action. */
const wrappedAction =
  (child: AnyDefinition, wrap: (wrapper: Intent, proposal: Proposal) => Proposal): Action => (wrapper) =>
    Effect.map(child.actions[wrapper.intent._tag]!(wrapper.intent), (proposal) => wrap(wrapper, proposal))

const appliedTo = (child: AnyDefinition, value: Model, forwarded: Option.Option<Proposal>): Model =>
  Option.match(forwarded, {
    onNone: () => value,
    onSome: (proposal) => foldAcceptors(child.acceptors, value, proposal)
  })

const slotRuntime = (name: string, part: SlotPart<AnyDefinition, AnyDefinition>): PartRuntime => {
  const { child, fromParent, toParent } = part
  return {
    name,
    schemas: {
      model: child.model,
      representation: child.representation,
      proposal: Schema.TaggedStruct(name, { proposal: child.proposal }),
      intent: Schema.TaggedStruct(name, { intent: child.intent })
    },
    initial: () => child.initial,
    accept: (value, wrapper) => foldAcceptors(child.acceptors, value, wrapper.proposal),
    react: foldReactors(child.reactors),
    forwardUp: toParent === undefined ? undefined : (_, wrapper) => toParent(wrapper.proposal),
    forwardDown: fromParent === undefined ? undefined : (value, proposal) =>
      appliedTo(child, value, fromParent(proposal)),
    state: child.state,
    nap: (representation) => child.nap(representation).map((intent) => ({ _tag: name, intent })),
    intentKey: (wrapper: Intent) => `${name}/${intentKeyOf(child, wrapper.intent)}`,
    action: wrappedAction(child, (_, proposal) => ({ _tag: name, proposal })),
    label: (wrapper) => `${name}/${proposalLabel(child, wrapper.proposal)}`
  }
}

/** Instances in `keys` order. An instance already held is kept as is, a new key gets `create`'s model, the others go. */
const reconcileInstances = (
  instances: ReadonlyArray<Instance>,
  keys: ReadonlyArray<string>,
  create: (key: string) => Model
): ReadonlyArray<Instance> => {
  const unchanged = instances.length === keys.length && instances.every((instance, index) => instance.key === keys[index])
  if (unchanged) return instances
  const held = new Map<string, Instance>()
  for (const instance of instances) if (!held.has(instance.key)) held.set(instance.key, instance)
  return keys.map((key) => held.get(key) ?? { key, model: create(key) })
}

const uniqueKeys = (keys: ReadonlyArray<string>): ReadonlyArray<string> => {
  const unique = new Set(keys)
  return unique.size === keys.length ? keys : [...unique]
}

/** `update` returns the instance's model, which is the one it was given when nothing changed; the array and the instances that did not change keep their identity. */
const mapInstances = (
  instances: ReadonlyArray<Instance>,
  update: (instance: Instance) => Model
): ReadonlyArray<Instance> => {
  let next: Array<Instance> | undefined
  instances.forEach((instance, index) => {
    const model = update(instance)
    if (model === instance.model) return
    next ??= instances.slice()
    next[index] = { key: instance.key, model }
  })
  return next ?? instances
}

const collectionSchemas = (name: string, child: AnyDefinition) => ({
  model: Schema.Array(Schema.Struct({ key: Schema.String, model: child.model })),
  representation: Schema.Array(Schema.Struct({ key: Schema.String, representation: child.representation })),
  proposal: Schema.TaggedStruct(name, { key: Schema.String, proposal: child.proposal }),
  intent: Schema.TaggedStruct(name, { key: Schema.String, intent: child.intent })
})

const holdsKey = (instances: ReadonlyArray<Instance>, key: string): boolean =>
  instances.some((instance) => instance.key === key)

const acceptByKey = (child: AnyDefinition): PartRuntime["accept"] => (instances, wrapper) =>
  holdsKey(instances, wrapper.key)
    ? mapInstances(instances, (instance) =>
      instance.key === wrapper.key ? foldAcceptors(child.acceptors, instance.model, wrapper.proposal) : instance.model)
    : instances

const forwardUpByKey =
  (toParent: NonNullable<CollectionPart<AnyDefinition, AnyDefinition>["toParent"]>) =>
  (instances: ReadonlyArray<Instance>, wrapper: Proposal): Option.Option<Proposal> =>
    holdsKey(instances, wrapper.key) ? toParent(wrapper.proposal, wrapper.key) : Option.none()

const forwardDownToEach = (
  child: AnyDefinition,
  fromParent: NonNullable<CollectionPart<AnyDefinition, AnyDefinition>["fromParent"]>
) =>
(instances: ReadonlyArray<Instance>, proposal: Proposal): ReadonlyArray<Instance> =>
  mapInstances(instances, (instance) => appliedTo(child, instance.model, fromParent(proposal, instance.key)))

const collectionRuntime = (name: string, part: CollectionPart<AnyDefinition, AnyDefinition>): PartRuntime => {
  const { child, fromParent, keys, toParent } = part
  const create = part.create ?? (() => child.initial)
  const reactor = foldReactors(child.reactors)
  const reconcile = (instances: ReadonlyArray<Instance>, parent: Model) =>
    reconcileInstances(instances, uniqueKeys(keys(parent)), (key) => create(key, parent))
  return {
    name,
    schemas: collectionSchemas(name, child),
    initial: (parent) => reconcile([], parent),
    accept: acceptByKey(child),
    react: reactor === undefined ? undefined : (instances) => mapInstances(instances, (instance) => reactor(instance.model)),
    reconcile,
    forwardUp: toParent === undefined ? undefined : forwardUpByKey(toParent),
    forwardDown: fromParent === undefined ? undefined : forwardDownToEach(child, fromParent),
    state: (instances: ReadonlyArray<Instance>) =>
      instances.map((instance) => ({ key: instance.key, representation: child.state(instance.model) })),
    nap: (representation: ReadonlyArray<{ readonly key: string; readonly representation: Representation }>) =>
      representation.flatMap((instance) =>
        child.nap(instance.representation).map((intent) => ({ _tag: name, key: instance.key, intent }))
      ),
    intentKey: (wrapper: Intent) => `${name}[${wrapper.key}]/${intentKeyOf(child, wrapper.intent)}`,
    action: wrappedAction(child, (wrapper: Intent, proposal) => ({ _tag: name, key: wrapper.key, proposal })),
    label: (wrapper) => `${name}[${wrapper.key}]/${proposalLabel(child, wrapper.proposal)}`
  }
}

const runtimeOf = (name: string, part: AnyPart): PartRuntime =>
  part.kind === "slot" ? slotRuntime(name, part) : collectionRuntime(name, part)

const assertPartNames = (parent: AnyDefinition, names: ReadonlyArray<string>) => {
  const taken = new Set([...tagsOf(parent.proposal.ast), ...tagsOf(parent.intent.ast)])
  for (const name of names) {
    if (!PART_NAME.test(name)) throw new Error(`mufw: compose: "${name}" is not a PascalCase part name`)
    if (taken.has(name)) throw new Error(`mufw: compose: ${parent.name} already has a "${name}" proposal or intent tag`)
  }
}

const withParent = (model: Model, parent: Model): Model => parent === model.parent ? model : { ...model, parent }

const withPart = (model: Model, name: string, value: Model): Model =>
  value === model.parts[name] ? model : { ...model, parts: { ...model.parts, [name]: value } }

const parentAcceptor = (parent: AnyDefinition, names: ReadonlySet<string>): Acceptor => (model, proposal) =>
  names.has(proposal._tag) ? model : withParent(model, foldAcceptors(parent.acceptors, model.parent, proposal))

const routedAcceptor = (runtime: PartRuntime): Acceptor => (model, proposal) =>
  proposal._tag === runtime.name
    ? withPart(model, runtime.name, runtime.accept(model.parts[runtime.name], proposal))
    : model

const forwardUpAcceptor = (
  parent: AnyDefinition,
  runtime: PartRuntime,
  forwardUp: NonNullable<PartRuntime["forwardUp"]>
): Acceptor =>
(model, proposal) => {
  if (proposal._tag !== runtime.name) return model
  return Option.match(forwardUp(model.parts[runtime.name], proposal), {
    onNone: () => model,
    onSome: (forwarded) => withParent(model, foldAcceptors(parent.acceptors, model.parent, forwarded))
  })
}

const forwardDownAcceptor = (
  runtime: PartRuntime,
  names: ReadonlySet<string>,
  forwardDown: NonNullable<PartRuntime["forwardDown"]>
): Acceptor =>
(model, proposal) =>
  names.has(proposal._tag) ? model : withPart(model, runtime.name, forwardDown(model.parts[runtime.name], proposal))

/** Routed acceptors first, forwarding last: a forwarded proposal lands on a side that already took its own. */
const composedAcceptors = (
  parent: AnyDefinition,
  runtimes: ReadonlyArray<PartRuntime>,
  names: ReadonlySet<string>
): Array<Acceptor> => [
  parentAcceptor(parent, names),
  ...runtimes.map(routedAcceptor),
  ...runtimes.flatMap((runtime) =>
    runtime.forwardUp === undefined ? [] : [forwardUpAcceptor(parent, runtime, runtime.forwardUp)]
  ),
  ...runtimes.flatMap((runtime) =>
    runtime.forwardDown === undefined ? [] : [forwardDownAcceptor(runtime, names, runtime.forwardDown)]
  )
]

const partReactor = (runtime: PartRuntime, react: NonNullable<PartRuntime["react"]>): Reactor => (model) =>
  withPart(model, runtime.name, react(model.parts[runtime.name]))

/** After every part's reactors, each collection holds one instance per key of the parent's model, in its order. */
const reconcileReactor = (runtimes: ReadonlyArray<PartRuntime>): Reactor => (model) =>
  runtimes.reduce(
    (current, runtime) =>
      runtime.reconcile === undefined
        ? current
        : withPart(current, runtime.name, runtime.reconcile(current.parts[runtime.name], current.parent)),
    model
  )

const composedReactors = (parent: AnyDefinition, runtimes: ReadonlyArray<PartRuntime>): Array<Reactor> => {
  const parentReact = foldReactors(parent.reactors)
  return [
    ...(parentReact === undefined ? [] : [(model: Model) => withParent(model, parentReact(model.parent))]),
    ...runtimes.flatMap((runtime) => runtime.react === undefined ? [] : [partReactor(runtime, runtime.react)]),
    reconcileReactor(runtimes)
  ]
}

const byName = <A>(runtimes: ReadonlyArray<PartRuntime>, pick: (runtime: PartRuntime) => A): Record<string, A> => {
  const record: Record<string, A> = {}
  for (const runtime of runtimes) record[runtime.name] = pick(runtime)
  return record
}

const composedSchemas = (
  parent: AnyDefinition,
  runtimes: ReadonlyArray<PartRuntime>,
  controlStates: ReadonlyArray<string>
) => ({
  model: Schema.Struct({
    parent: parent.model,
    parts: Schema.Struct(byName(runtimes, (runtime) => runtime.schemas.model))
  }),
  proposal: Schema.Union([parent.proposal, ...runtimes.map((runtime) => runtime.schemas.proposal)]),
  intent: Schema.Union([parent.intent, ...runtimes.map((runtime) => runtime.schemas.intent)]),
  representation: Schema.Struct({
    controlState: Schema.Literals(controlStates),
    parent: parent.representation,
    parts: Schema.Struct(byName(runtimes, (runtime) => runtime.schemas.representation))
  })
})

const composedState = (parent: AnyDefinition, runtimes: ReadonlyArray<PartRuntime>, options: LooseOptions) => {
  const controlState = options.controlState ?? ((rest: { readonly parent: Representation }) => rest.parent.controlState)
  return (model: Model) => {
    const rest = {
      parent: parent.state(model.parent),
      parts: byName(runtimes, (runtime) => runtime.state(model.parts[runtime.name]))
    }
    return { controlState: controlState(rest), ...rest }
  }
}

/** The parent's intents, then each part's in the order the parts record declares them; a collection's instances in collection order. */
const composedNap = (parent: AnyDefinition, runtimes: ReadonlyArray<PartRuntime>) =>
(representation: Representation): ReadonlyArray<Tagged> => [
  ...parent.nap(representation.parent),
  ...runtimes.flatMap((runtime) => runtime.nap(representation.parts[runtime.name]))
]

/** A part's intent is keyed under its wire address and the child's own key, so distinct intents never block each other. */
const composedIntentKey =
  (parent: AnyDefinition, parts: ReadonlyMap<string, PartRuntime>) => (intent: Tagged): string =>
    parts.get(intent._tag)?.intentKey(intent) ?? intentKeyOf(parent, intent)

const composedLabel =
  (parent: AnyDefinition, parts: ReadonlyMap<string, PartRuntime>) => (proposal: Proposal): string =>
    parts.get(proposal._tag)?.label(proposal) ?? proposalLabel(parent, proposal)

const composeLoosely = (
  parent: AnyDefinition,
  parts: Readonly<Record<string, AnyPart>>,
  options: LooseOptions
): AnyDefinition => {
  const entries = Object.entries(parts)
  assertPartNames(parent, entries.map(([name]) => name))
  const runtimes = entries.map(([name, part]) => runtimeOf(name, part))
  const runtimeByName = new Map(runtimes.map((runtime) => [runtime.name, runtime]))
  const names = new Set(runtimeByName.keys())
  const controlStates = options.controlStates ?? parent.controlStates
  return {
    name: options.name ?? `${parent.name}/${[...names].join("+")}`,
    ...composedSchemas(parent, runtimes, controlStates),
    controlStates,
    initial: { parent: parent.initial, parts: byName(runtimes, (runtime) => runtime.initial(parent.initial)) },
    acceptors: composedAcceptors(parent, runtimes, names),
    reactors: composedReactors(parent, runtimes),
    state: composedState(parent, runtimes, options),
    nap: composedNap(parent, runtimes),
    intentKey: composedIntentKey(parent, runtimeByName),
    proposalLabel: composedLabel(parent, runtimeByName),
    actions: { ...parent.actions, ...byName(runtimes, (runtime) => runtime.action) }
  }
}

const partBuilder = <PD extends AnyDefinition>(): PartBuilder<PD> => ({
  slot: (child, hooks) => ({ kind: "slot", child, ...hooks }),
  collection: (child, options) => ({ kind: "collection", child, ...options })
})

/**
 * Composes sibling parts into `parent` as one definition, so one loop, one history and one graph
 * cover the parent and every part. `parts` receives a builder and returns the parts by name:
 *
 * ```ts
 * compose(Parent, (part) => ({
 *   Left: part.slot(Counter),
 *   Rows: part.collection(Counter, { keys: (parent) => parent.ids })
 * }))
 * ```
 *
 * A part is a slot (one instance of a child definition) or a collection (an ordered, keyed,
 * runtime-sized set of instances of one child definition). Parts may share a child definition.
 *
 * - model `{ parent, parts: { [Name]: slot model | ReadonlyArray<{ key, model }> } }`; representation
 *   `{ controlState, parent, parts: { [Name]: slot representation | ReadonlyArray<{ key, representation }> } }`
 * - the parent's proposals and intents keep their tags; a slot's are wrapped as
 *   `{ _tag: Name, proposal | intent }`, a collection's as `{ _tag: Name, key, proposal | intent }`
 * - a parent acceptor sees only `model.parent` and parent proposals, a slot's acceptor only the slot's
 *   model and the payload of its wrapper, a collection wrapper only the instance with its `key`; a
 *   proposal addressed to a key the collection does not hold changes nothing and is not forwarded
 * - the parent owns each collection: after the acceptors, forwarding and the reactors, it holds one
 *   instance per key of `keys(parent model)` in that order (a new key gets `create`'s model, an
 *   instance whose key is gone is dropped, a repeated key counts once); `initial` reconciles from
 *   the parent's initial model, so only a change to the parent's model creates or removes an instance
 * - `toParent`/`fromParent` forward an accepted proposal in the same step: one hop, so a forwarded
 *   proposal reaches the acceptors of its target only. Parts never forward to each other directly
 * - `controlState` is the parent's unless `options.controlState` combines the rest of the
 *   representation, in which case `options.controlStates` lists its values
 * - `nap` offers the parent's intents, then each part's in the order `parts` declares them (a
 *   collection's instances in collection order), in one step; an intent is keyed `Name/<child key>`
 *   or `Name[<key>]/<child key>`, so two instances' actions run
 *   concurrently and one instance's repeated automatic intent is skipped; a proposal is labelled
 *   `Name/<child label>` or `Name[<key>]/<child label>`
 * - the services of the result are those of the parent and every part
 *
 * Throws when a part name is not PascalCase or is a proposal or intent tag of `parent`.
 */
export const compose = <
  PD extends AnyDefinition,
  Parts extends AnyParts,
  S extends string = RepresentationOf<PD>["controlState"]
>(
  parent: PD,
  parts: (part: PartBuilder<PD>) => Parts,
  options?: ComposeOptions<PD, Parts, S>
): Composed<PD, Parts, S> =>
  // The loose definition's schemas are the composed ones; TypeScript cannot compose them over generic `PD`, `Parts`.
  composeLoosely(parent, parts(partBuilder<PD>()), options ?? {}) as Composed<PD, Parts, S>
