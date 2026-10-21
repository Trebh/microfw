import { describe, expect, it } from "@effect/vitest"
import {
  exploreGraph,
  type Explore,
  shortestPaths,
  simplePaths,
  toXStateDefinition,
  unreachableControlStates
} from "../src/index.ts"
import { Counter } from "./fixtures/Counter.ts"

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
