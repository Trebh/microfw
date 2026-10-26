import { compose, type Explore, makePorts } from "../../src/index.ts"
import { Counter } from "./Counter.ts"
import { Roster } from "./Roster.ts"

/**
 * One counter per id of the roster; a new row starts at the number of ids the roster holds. The
 * composite is `busy` while any row is high, else the roster's own control state.
 */
export const CounterRows = compose(Roster, (part) => ({
  Rows: part.collection(Counter, {
    keys: (roster) => roster.ids,
    create: (_, roster) => ({ count: roster.ids.length })
  })
}), {
  controlState: (rest) =>
    rest.parts.Rows.some((row) => row.representation.controlState === "high") ? "busy" : rest.parent.controlState,
  controlStates: ["empty", "listed", "busy"]
})

export const RowsPorts = makePorts(CounterRows)

const ROW_IDS = ["a", "b"]

/** At most two rows, each offered `Inc` only while it is low, so exploration is finite. */
export const exploreRows: Explore<typeof CounterRows> = (_, model) => [
  ...ROW_IDS.filter((id) => !model.parent.ids.includes(id)).map((id) => ({ _tag: "Added", id }) as const),
  ...model.parent.ids.map((id) => ({ _tag: "Removed", id }) as const),
  ...model.parts.Rows.flatMap((row) => [
    ...(row.model.count < 3 ? [{ _tag: "Rows", key: row.key, proposal: { _tag: "Inc", by: 3 } } as const] : []),
    ...(row.model.count > 0 ? [{ _tag: "Rows", key: row.key, proposal: { _tag: "Reset" } } as const] : [])
  ])
]
