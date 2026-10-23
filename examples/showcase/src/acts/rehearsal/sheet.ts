import type { Path } from "@mufw/core"
import type { BoxOffice } from "../../domain/BoxOffice.ts"
import { expectations, honestRehearsal } from "./understudy.ts"

/** Consecutive steps of one proposal, written once with how many times it is called. */
export interface StepTag {
  readonly name: string
  readonly times: number
}

/** One line of the call sheet: a path of the explored graph, as `describe` names it and as tags. */
export interface CallSheetLine {
  readonly index: number
  readonly path: Path<typeof BoxOffice>
  readonly target: string
  /** `describe(path)` up to its steps: "reaches full". */
  readonly reach: string
  /** `describe(path)` in full. */
  readonly name: string
  /** The proposal of each step, in order. */
  readonly stepNames: ReadonlyArray<string>
  readonly tags: ReadonlyArray<StepTag>
}

const runLengths = (names: ReadonlyArray<string>): ReadonlyArray<StepTag> => {
  const tags: Array<StepTag> = []
  for (const name of names) {
    const last = tags.at(-1)
    if (last !== undefined && last.name === name) tags[tags.length - 1] = { name, times: last.times + 1 }
    else tags.push({ name, times: 1 })
  }
  return tags
}

const lineOf = (path: Path<typeof BoxOffice>, index: number): CallSheetLine => {
  const name = honestRehearsal.describe(path)
  const stepNames = path.steps.map((step) => step.proposal._tag)
  return {
    index,
    path,
    target: path.target,
    reach: name.split(" via ")[0] ?? name,
    name,
    stepNames,
    tags: runLengths(stepNames)
  }
}

/** Every shortest path of the explored graph, one per control state. */
export const callSheet: ReadonlyArray<CallSheetLine> = honestRehearsal.shortestPaths().map(lineOf)

export interface GraphNodeNote {
  readonly name: string
  readonly expects: string
}

/** The explored graph's nodes, each with the assertion its control state is held to. */
export const graphNodes: ReadonlyArray<GraphNodeNote> = Object.entries(expectations)
  .filter(([name]) => honestRehearsal.graph.nodes.has(name))
  .map(([name, { expects }]) => ({ name, expects }))

export interface GraphEdgeNote {
  readonly from: string
  readonly proposal: string
  readonly to: string
  readonly times: number
}

const summariseEdges = (): ReadonlyArray<GraphEdgeNote> => {
  const notes = new Map<string, GraphEdgeNote>()
  for (const edge of honestRehearsal.graph.edges) {
    const proposal = edge.proposal._tag
    const key = `${edge.from}|${proposal}|${edge.to}`
    const known = notes.get(key)
    notes.set(key, { from: edge.from, proposal, to: edge.to, times: (known?.times ?? 0) + 1 })
  }
  return [...notes.values()]
}

/** The explored transitions, the same proposal between the same two states counted once with its number of variants. */
export const graphEdges: ReadonlyArray<GraphEdgeNote> = summariseEdges()
