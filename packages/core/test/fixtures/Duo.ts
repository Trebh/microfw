import { Option } from "effect"
import { compose, type Explore, makePorts } from "../../src/index.ts"
import { Counter } from "./Counter.ts"
import { Tally } from "./Tally.ts"

/**
 * Two counters under a tally. `Left` reports its increments to the tally, and the tally's
 * `Zeroed` resets it; `Right` has no hooks. The control state combines both counters'.
 */
export const Duo = compose(Tally, (part) => ({
  Left: part.slot(Counter, {
    toParent: (proposal) => (proposal._tag === "Inc" ? Option.some({ _tag: "Bumped", by: proposal.by }) : Option.none()),
    fromParent: (proposal) => (proposal._tag === "Zeroed" ? Option.some({ _tag: "Reset" } as const) : Option.none())
  }),
  Right: part.slot(Counter)
}), {
  controlState: (rest) => `${rest.parts.Left.controlState}/${rest.parts.Right.controlState}` as const,
  controlStates: ["low/low", "low/high", "high/low", "high/high"]
})

export const DuoPorts = makePorts(Duo)

/** A counter stops being offered `Inc` once it is high, and `Left` once the total is 3 or more, so exploration is finite. */
export const exploreDuo: Explore<typeof Duo> = (_, model) => [
  { _tag: "Zeroed" },
  ...(model.parent.total < 3 && model.parts.Left.count < 3
    ? [
      { _tag: "Left", proposal: { _tag: "Inc", by: 1 } } as const,
      { _tag: "Left", proposal: { _tag: "Inc", by: 3 } } as const
    ]
    : []),
  ...(model.parts.Left.count > 0 ? [{ _tag: "Left", proposal: { _tag: "Reset" } } as const] : []),
  ...(model.parts.Right.count < 3
    ? [
      { _tag: "Right", proposal: { _tag: "Inc", by: 1 } } as const,
      { _tag: "Right", proposal: { _tag: "Inc", by: 3 } } as const
    ]
    : []),
  ...(model.parts.Right.count > 0 ? [{ _tag: "Right", proposal: { _tag: "Reset" } } as const] : [])
]
