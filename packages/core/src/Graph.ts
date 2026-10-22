import { Option } from "effect"
import type { AnyDefinition, ModelOf, ProposalOf, RepresentationOf } from "./Definition.ts"
import { applyProposal, type StepRecord } from "./Step.ts"

/** Sample alphabet of proposals to try from a state, written next to the definition. */
export type Explore<D extends AnyDefinition> = (
  representation: RepresentationOf<D>,
  model: ModelOf<D>
) => ReadonlyArray<ProposalOf<D>>

export interface ExploreOptions<D extends AnyDefinition> {
  /** Groups states into graph nodes; default: the control state. */
  readonly key?: (representation: RepresentationOf<D>) => string
  /**
   * Identifies the states exploration expands; default: `key`. A finer identity lets exploration
   * continue through states that share a node but differ in what they enable (e.g. a deadline reached).
   */
  readonly serialize?: (representation: RepresentationOf<D>, model: ModelOf<D>) => string
  /** Maximum number of explored states; default 1 000. */
  readonly limit?: number
}

export interface GraphNode<D extends AnyDefinition> {
  readonly key: string
  readonly model: ModelOf<D>
  readonly representation: RepresentationOf<D>
}

export interface GraphEdge<D extends AnyDefinition> {
  readonly from: string
  readonly to: string
  readonly proposal: ProposalOf<D>
}

export interface PathStep<D extends AnyDefinition> {
  readonly from: string
  readonly proposal: ProposalOf<D>
  readonly to: string
}

export interface Path<D extends AnyDefinition> {
  readonly target: string
  readonly steps: ReadonlyArray<PathStep<D>>
}

export interface ExploredState<D extends AnyDefinition> extends GraphNode<D> {
  readonly id: string
}

export interface GraphTransition<D extends AnyDefinition> {
  readonly proposal: ProposalOf<D>
  readonly to: string
}

export interface Graph<D extends AnyDefinition> {
  readonly initial: string
  readonly nodes: ReadonlyMap<string, GraphNode<D>>
  readonly edges: ReadonlyArray<GraphEdge<D>>
  /** State-level transitions, keyed by state id; what path generation walks. */
  readonly initialState: string
  readonly states: ReadonlyMap<string, ExploredState<D>>
  readonly transitions: ReadonlyMap<string, ReadonlyArray<GraphTransition<D>>>
}

const DEFAULT_LIMIT = 1_000

/** Breadth-first exploration of the states reachable from `def.initial` through `explore`. */
export const exploreGraph = <D extends AnyDefinition>(
  def: D,
  explore: Explore<D>,
  options: ExploreOptions<D> = {}
): Graph<D> => {
  const key = options.key ?? ((representation: RepresentationOf<D>) => representation.controlState)
  const serialize = options.serialize ?? ((representation: RepresentationOf<D>) => key(representation))
  const limit = options.limit ?? DEFAULT_LIMIT
  const toState = (model: ModelOf<D>): ExploredState<D> => {
    const representation = def.state(model)
    return { id: serialize(representation, model), key: key(representation), model, representation }
  }
  const initial = toState(def.initial)
  const states = new Map([[initial.id, initial]])
  const nodes = new Map<string, GraphNode<D>>([[initial.key, initial]])
  const transitions = new Map<string, Array<GraphTransition<D>>>()
  const edges = new Map<string, GraphEdge<D>>()
  const queue = [initial]
  for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
    const outgoing: Array<GraphTransition<D>> = []
    transitions.set(state.id, outgoing)
    for (const proposal of explore(state.representation, state.model)) {
      const next = toState(applyProposal(def, state.model, proposal))
      outgoing.push({ proposal, to: next.id })
      const edge = { from: state.key, to: next.key, proposal }
      edges.set(JSON.stringify(edge), edge)
      if (!nodes.has(next.key)) nodes.set(next.key, next)
      if (states.has(next.id)) continue
      if (states.size >= limit) throw new Error(`mufw graph limit exceeded: ${limit}`)
      states.set(next.id, next)
      queue.push(next)
    }
  }
  return {
    initial: initial.key,
    nodes,
    edges: [...edges.values()],
    initialState: initial.id,
    states,
    transitions
  }
}

const toPathStep = <D extends AnyDefinition>(graph: Graph<D>, from: string, transition: GraphTransition<D>) => ({
  from: graph.states.get(from)!.key,
  proposal: transition.proposal,
  to: graph.states.get(transition.to)!.key
})

/** One shortest path per node, in breadth-first order; the initial node has no steps. */
export const shortestPaths = <D extends AnyDefinition>(graph: Graph<D>): ReadonlyArray<Path<D>> => {
  const reached = new Map<string, ReadonlyArray<PathStep<D>>>([[graph.initialState, []]])
  const paths: Array<Path<D>> = [{ target: graph.initial, steps: [] }]
  const targets = new Set([graph.initial])
  const queue = [graph.initialState]
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const prefix = reached.get(id)!
    for (const transition of graph.transitions.get(id) ?? []) {
      if (reached.has(transition.to)) continue
      const step = toPathStep(graph, id, transition)
      const steps = [...prefix, step]
      reached.set(transition.to, steps)
      queue.push(transition.to)
      if (targets.has(step.to)) continue
      targets.add(step.to)
      paths.push({ target: step.to, steps })
    }
  }
  return paths
}

const isStrictPrefix = <D extends AnyDefinition>(shorter: Path<D>, longer: Path<D>) =>
  shorter.target === longer.target &&
  shorter.steps.length < longer.steps.length &&
  shorter.steps.every((step, index) => step === longer.steps[index])

/**
 * Depth-first paths that never revisit a state, one per state reached. A path that is a strict
 * prefix of a longer path to the same node is dropped: the longer one already covers it.
 */
export const simplePaths = <D extends AnyDefinition>(graph: Graph<D>): ReadonlyArray<Path<D>> => {
  const found: Array<Path<D>> = []
  const visit = (id: string, steps: ReadonlyArray<PathStep<D>>, visited: ReadonlySet<string>) => {
    found.push({ target: graph.states.get(id)!.key, steps })
    for (const transition of graph.transitions.get(id) ?? []) {
      if (visited.has(transition.to)) continue
      const step = toPathStep(graph, id, transition)
      visit(transition.to, [...steps, step], new Set([...visited, transition.to]))
    }
  }
  visit(graph.initialState, [], new Set([graph.initialState]))
  return found.filter((path) => !found.some((other) => isStrictPrefix(path, other)))
}

/** Declared control states no explored node carries (meaningful with the default `key`). */
export const unreachableControlStates = <D extends AnyDefinition>(def: D, graph: Graph<D>): ReadonlyArray<string> =>
  def.controlStates.filter((controlState) => !graph.nodes.has(controlState))

/** A proposal tag leads to one node, or to several depending on the model (guarded in XState terms). */
export type XStateTransition = string | ReadonlyArray<{ readonly target: string }>

export interface XStateDefinition {
  readonly id: string
  readonly initial: string
  readonly states: Record<string, { readonly on: Record<string, XStateTransition> }>
}

/**
 * XState machine config of the graph: `on[proposalTag]` is the target node, or every distinct
 * target in edge order when the same tag leads to several nodes.
 */
export const toXStateDefinition = <D extends AnyDefinition>(def: D, graph: Graph<D>): XStateDefinition => {
  const targets = new Map<string, Map<string, Array<string>>>([...graph.nodes.keys()].map((node) => [node, new Map()]))
  for (const edge of graph.edges) {
    const byTag = targets.get(edge.from)!
    const seen = byTag.get(edge.proposal._tag) ?? []
    if (!seen.includes(edge.to)) byTag.set(edge.proposal._tag, [...seen, edge.to])
  }
  const states: Record<string, { on: Record<string, XStateTransition> }> = {}
  for (const [node, byTag] of targets) {
    const on: Record<string, XStateTransition> = {}
    for (const [tag, list] of byTag) on[tag] = list.length === 1 ? list[0]! : list.map((target) => ({ target }))
    states[node] = { on }
  }
  return { id: def.name, initial: graph.initial, states }
}

export type MergeOptions<D extends AnyDefinition> = Pick<ExploreOptions<D>, "key">

/**
 * An explored graph plus the transitions a history crossed. `states` and `transitions` stay those
 * of exploration: path generation walks explored behaviour only.
 */
export interface MergedGraph<D extends AnyDefinition> extends Graph<D> {
  /** Every edge the history crossed, explored or not; each is an element of `edges`. */
  readonly observed: ReadonlyArray<GraphEdge<D>>
  /** The observed edges exploration did not produce: transitions the sample alphabet missed. */
  readonly unexplored: ReadonlyArray<GraphEdge<D>>
}

interface ObservedTransition<D extends AnyDefinition> {
  readonly from: GraphNode<D>
  readonly to: GraphNode<D>
  readonly proposal: ProposalOf<D>
}

/** JSON with sorted object keys: the same proposal read back from a history or written in a sample is one edge. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, nested: unknown) =>
    typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : nested)

const nodeOf = <D extends AnyDefinition>(
  record: StepRecord<D>,
  key: (representation: RepresentationOf<D>) => string
): GraphNode<D> => ({ key: key(record.representation), model: record.model, representation: record.representation })

/**
 * The transitions of a history: a `step` record with a proposal, read against the record just
 * before it, whatever its kind (after a `travel` the step leaves the restored state). `init` and
 * `travel` records are not transitions, and a step whose predecessor is missing from `records`
 * (evicted, or never exported) has no known source and is skipped.
 */
const observedTransitions = <D extends AnyDefinition>(
  records: ReadonlyArray<StepRecord<D>>,
  key: (representation: RepresentationOf<D>) => string
): ReadonlyArray<ObservedTransition<D>> =>
  records.flatMap((record, index): ReadonlyArray<ObservedTransition<D>> => {
    const previous = records[index - 1]
    if (previous === undefined || record.kind !== "step" || previous.seq !== record.seq - 1) return []
    return Option.toArray(
      Option.map(record.proposal, (proposal) => ({ from: nodeOf(previous, key), to: nodeOf(record, key), proposal }))
    )
  })

/**
 * Adds what a history crossed to an explored graph: the nodes it reached that exploration did not,
 * and one edge per distinct `key(previous) --proposal--> key(next)` transition. An edge exploration
 * already holds is marked observed, not duplicated. `key` must be the one the graph was explored
 * with (default: the control state), since observed states are keyed by their recorded
 * representation.
 */
export const mergeHistory = <D extends AnyDefinition>(
  graph: Graph<D>,
  records: ReadonlyArray<StepRecord<D>>,
  options: MergeOptions<D> = {}
): MergedGraph<D> => {
  const key = options.key ?? ((representation: RepresentationOf<D>) => representation.controlState)
  const nodes = new Map(graph.nodes)
  const edgeById = new Map(graph.edges.map((edge) => [canonical(edge), edge]))
  const exploredIds = new Set(edgeById.keys())
  const observedById = new Map<string, GraphEdge<D>>()
  for (const transition of observedTransitions(records, key)) {
    for (const node of [transition.from, transition.to]) if (!nodes.has(node.key)) nodes.set(node.key, node)
    const crossed = { from: transition.from.key, to: transition.to.key, proposal: transition.proposal }
    const id = canonical(crossed)
    const edge = edgeById.get(id) ?? crossed
    edgeById.set(id, edge)
    observedById.set(id, edge)
  }
  return {
    ...graph,
    nodes,
    edges: [...edgeById.values()],
    observed: [...observedById.values()],
    unexplored: [...observedById].filter(([id]) => !exploredIds.has(id)).map(([, edge]) => edge)
  }
}
