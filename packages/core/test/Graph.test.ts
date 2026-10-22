import { describe, expect, it } from "@effect/vitest"
import {
  exploreGraph,
  type Explore,
  mergeHistory,
  shortestPaths,
  simplePaths,
  toXStateDefinition,
  unreachableControlStates
} from "../src/index.ts"
import { Counter } from "./fixtures/Counter.ts"
import { initRecord, stepRecord, travelRecord } from "./fixtures/CounterHistory.ts"

const inc1 = { _tag: "Inc", by: 1 } as const
const inc3 = { _tag: "Inc", by: 3 } as const
const reset = { _tag: "Reset" } as const
const explore: Explore<typeof Counter> = () => [inc1, inc3, reset]

describe("exploreGraph", () => {
  it("finds one node per control state and one edge per explored proposal", () => {
    const graph = exploreGraph(Counter, explore)

    expect([...graph.nodes.keys()]).toEqual(["low", "high"])
    expect(graph.edges).toEqual([
      { from: "low", to: "low", proposal: inc1 },
      { from: "low", to: "high", proposal: inc3 },
      { from: "low", to: "low", proposal: reset },
      { from: "high", to: "high", proposal: inc1 },
      { from: "high", to: "high", proposal: inc3 },
      { from: "high", to: "low", proposal: reset }
    ])
  })

  it("throws when exploration exceeds the limit", () => {
    const byCount = (representation: { readonly count: number }) => String(representation.count)

    expect(() => exploreGraph(Counter, explore, { key: byCount, limit: 5 })).toThrow(
      "mufw graph limit exceeded: 5"
    )
  })

  it("keeps exploring states that share a node but differ in serialization", () => {
    const toHigh: Explore<typeof Counter> = (representation) =>
      representation.count < 4 ? [{ _tag: "Inc", by: 2 }] : [reset]
    const graph = exploreGraph(Counter, toHigh, { serialize: (representation) => String(representation.count) })

    expect(shortestPaths(graph).map((path) => [path.target, path.steps.length])).toEqual([
      ["low", 0],
      ["high", 2]
    ])
  })
})

describe("paths", () => {
  const graph = exploreGraph(Counter, explore)

  it("shortestPaths returns one breadth-first path per node", () => {
    expect(shortestPaths(graph)).toEqual([
      { target: "low", steps: [] },
      { target: "high", steps: [{ from: "low", proposal: inc3, to: "high" }] }
    ])
  })

  it("simplePaths never revisits a node", () => {
    expect(simplePaths(graph)).toEqual([
      { target: "low", steps: [] },
      { target: "high", steps: [{ from: "low", proposal: inc3, to: "high" }] }
    ])
  })
})

describe("graph consumers", () => {
  const graph = exploreGraph(Counter, explore)

  it("unreachableControlStates lists declared states no node carries", () => {
    const declared = { ...Counter, controlStates: ["low", "high", "frozen"] }

    expect(unreachableControlStates(declared, graph)).toEqual(["frozen"])
  })

  it("toXStateDefinition lists every distinct target of a tag, in edge order", () => {
    expect(toXStateDefinition(Counter, graph)).toEqual({
      id: "counter",
      initial: "low",
      states: {
        low: { on: { Inc: [{ target: "low" }, { target: "high" }], Reset: "low" } },
        high: { on: { Inc: "high", Reset: "low" } }
      }
    })
  })
})

describe("mergeHistory", () => {
  const exploredOnlyInc3 = exploreGraph(Counter, () => [inc3])
  const observed = [initRecord(0), stepRecord(1, inc1, 1), stepRecord(2, inc3, 4)]

  it("adds an edge the history crossed and exploration missed", () => {
    const merged = mergeHistory(exploredOnlyInc3, observed)

    expect(merged.edges).toEqual([
      { from: "low", to: "high", proposal: inc3 },
      { from: "high", to: "high", proposal: inc3 },
      { from: "low", to: "low", proposal: inc1 }
    ])
    expect(merged.unexplored).toEqual([{ from: "low", to: "low", proposal: inc1 }])
  })

  it("marks an edge exploration already holds as observed without duplicating it", () => {
    const merged = mergeHistory(exploredOnlyInc3, observed)

    expect(merged.observed).toEqual([
      { from: "low", to: "low", proposal: inc1 },
      { from: "low", to: "high", proposal: inc3 }
    ])
    expect(merged.edges.filter((edge) => edge.proposal._tag === "Inc" && edge.proposal.by === 3)).toHaveLength(2)
  })

  it("recognises an explored edge whose proposal keys are written in another order", () => {
    const reordered = [initRecord(0), stepRecord(1, { by: 3, _tag: "Inc" }, 3)]

    const merged = mergeHistory(exploredOnlyInc3, reordered)

    expect(merged.unexplored).toEqual([])
    expect(merged.edges).toHaveLength(2)
  })

  it("adds a node exploration never reached", () => {
    const unexplored = exploreGraph(Counter, () => [])

    const merged = mergeHistory(unexplored, observed)

    expect([...merged.nodes.keys()]).toEqual(["low", "high"])
    expect(merged.nodes.get("high")?.model).toEqual({ count: 4 })
  })

  it("does not repeat an edge the history crosses twice", () => {
    const twice = [initRecord(0), stepRecord(1, inc1, 1), stepRecord(2, inc1, 2)]

    const merged = mergeHistory(exploreGraph(Counter, () => []), twice)

    expect(merged.observed).toEqual([{ from: "low", to: "low", proposal: inc1 }])
  })

  it("takes a step after a travel from the restored state, and the travel itself is no edge", () => {
    const travelled = [initRecord(0), stepRecord(1, inc3, 3), travelRecord(2, 0, 0), stepRecord(3, inc1, 1)]

    const merged = mergeHistory(exploreGraph(Counter, () => []), travelled)

    expect(merged.observed).toEqual([
      { from: "low", to: "high", proposal: inc3 },
      { from: "low", to: "low", proposal: inc1 }
    ])
  })

  it("skips a step whose predecessor is missing from the records", () => {
    const evicted = [initRecord(0), stepRecord(5, inc3, 3)]

    const merged = mergeHistory(exploreGraph(Counter, () => []), evicted)

    expect(merged.observed).toEqual([])
  })

  it("groups the recorded states with the key it is given", () => {
    const byCount = (representation: { readonly count: number }) => String(representation.count)

    const merged = mergeHistory(exploreGraph(Counter, () => [], { key: byCount }), observed, { key: byCount })

    expect(merged.observed).toEqual([
      { from: "0", to: "1", proposal: inc1 },
      { from: "1", to: "4", proposal: inc3 }
    ])
  })

  it("leaves the explored graph untouched", () => {
    mergeHistory(exploredOnlyInc3, observed)

    expect(exploredOnlyInc3.edges).toHaveLength(2)
  })

  it("gives toXStateDefinition the observed transitions", () => {
    const merged = mergeHistory(exploredOnlyInc3, observed)

    expect(toXStateDefinition(Counter, merged)).toEqual({
      id: "counter",
      initial: "low",
      states: {
        low: { on: { Inc: [{ target: "high" }, { target: "low" }] } },
        high: { on: { Inc: "high" } }
      }
    })
  })
})
