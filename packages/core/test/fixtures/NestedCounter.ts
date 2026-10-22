import { Option } from "effect"
import { type Explore, makePorts, nest } from "../../src/index.ts"
import { Counter } from "./Counter.ts"

/** The Counter nested in itself; resetting the parent also resets the child. */
export const NestedCounter = nest(Counter, Counter, {
  controlState: (parent, child) => `${parent.controlState}/${child.controlState}` as const,
  controlStates: ["low/low", "low/high", "high/low", "high/high"],
  toChild: (proposal) => (proposal._tag === "Reset" ? Option.some({ _tag: "Reset" }) : Option.none())
})

export const NestedPorts = makePorts(NestedCounter)

export const exploreNested: Explore<typeof NestedCounter> = () => [
  { _tag: "Inc", by: 1 },
  { _tag: "Inc", by: 3 },
  { _tag: "Reset" },
  { _tag: "Child", proposal: { _tag: "Inc", by: 1 } },
  { _tag: "Child", proposal: { _tag: "Inc", by: 3 } },
  { _tag: "Child", proposal: { _tag: "Reset" } }
]
