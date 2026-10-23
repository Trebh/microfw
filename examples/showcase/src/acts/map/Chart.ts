import {
  exploreGraph,
  type Graph,
  type GraphEdge,
  mergeHistory,
  type Path,
  shortestPaths,
  type StepRecord,
  toXStateDefinition,
  unreachableControlStates
} from "@mufw/core"
import { BoxOffice, exploreBoxOffice, serializeBoxOffice } from "../../domain/BoxOffice.ts"
import { printXState } from "./Printer.ts"
import { groupKey, type Leg, type Proposal, type Way } from "./Survey.ts"

type StageGraph = Graph<typeof BoxOffice>
type StageRecord = StepRecord<typeof BoxOffice>

/** Everything the exploration of the Box Office yields, worked out once and only read afterwards. */
export interface Chart {
  readonly graph: StageGraph
  /** Explored states: the Box Office told apart as `serializeBoxOffice` tells them. */
  readonly states: number
  /** Graph nodes: the control states exploration reached. */
  readonly places: number
  /** One leg per distinct (from, proposal tag, to) of the explored edges, in discovery order. */
  readonly legs: ReadonlyArray<Leg>
  readonly explored: ReadonlySet<string>
  readonly ways: ReadonlyArray<Way>
  /** The XState config, as the lines of the card. */
  readonly xstate: ReadonlyArray<string>
  readonly unreachable: ReadonlyArray<string>
}

const legOf = (edge: GraphEdge<typeof BoxOffice>): Leg => ({
  from: edge.from,
  tag: edge.proposal._tag,
  to: edge.to
})

const distinctLegs = (graph: StageGraph): ReadonlyArray<Leg> => {
  const byKey = new Map<string, Leg>()
  for (const edge of graph.edges) {
    const leg = legOf(edge)
    if (!byKey.has(groupKey(leg))) byKey.set(groupKey(leg), leg)
  }
  return [...byKey.values()]
}

const wayOf = (path: Path<typeof BoxOffice>): Way => ({
  target: path.target,
  legs: path.steps.map((step) => ({ from: step.from, tag: step.proposal._tag, to: step.to }))
})

/** Explores the Box Office with its own sample alphabet, purely, and derives everything the map shows. */
export const surveyStage = (): Chart => {
  const graph = exploreGraph(BoxOffice, exploreBoxOffice, { serialize: serializeBoxOffice })
  const legs = distinctLegs(graph)
  return {
    graph,
    states: graph.states.size,
    places: graph.nodes.size,
    legs,
    explored: new Set(legs.map(groupKey)),
    ways: shortestPaths(graph).map(wayOf),
    xstate: printXState(toXStateDefinition(BoxOffice, graph)),
    unreachable: unreachableControlStates(BoxOffice, graph)
  }
}

/**
 * What the step from `previous` to `record` crossed, read by `mergeHistory`. A proposal carries a
 * payload (seat, time, patron) that the sample alphabet fixed, so the exact edge is almost never
 * the explored one; a crossing counts as missed only when no explored edge shares its places and tag.
 */
export const crossingsBetween = (
  chart: Chart,
  previous: StageRecord,
  record: StageRecord
): ReadonlyArray<Proposal> => {
  const merged = mergeHistory(chart.graph, [previous, record])
  return merged.observed.map((edge) => {
    const leg = legOf(edge)
    const missed = merged.unexplored.includes(edge) && !chart.explored.has(groupKey(leg))
    return { _tag: "Crossed", ...leg, missed } as const
  })
}
