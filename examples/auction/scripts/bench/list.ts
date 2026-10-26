import { define, makePorts, noIntent } from "@mufw/core"
import { Effect, Schema } from "effect"

/** Rows the list starts with: large enough that a step's cost scales with the model, as a real table's does. */
export const LIST_ROWS = 1000

const Row = Schema.Struct({ id: Schema.Int, on: Schema.Boolean })

/** A table of toggles: every step copies and re-renders a model that grows with the data. */
export const List = define({
  name: "benchList",
  model: Schema.Struct({ rows: Schema.Array(Row) }),
  proposal: Schema.Union([Schema.TaggedStruct("Toggle", { id: Schema.Int })]),
  intent: Schema.Union([Schema.TaggedStruct("Toggle", { id: Schema.Int })]),
  representation: Schema.Struct({ controlState: Schema.Literals(["ready"]), on: Schema.Int, rows: Schema.Array(Row) })
})({
  initial: { rows: Array.from({ length: LIST_ROWS }, (_, id) => ({ id, on: false })) },
  acceptors: {
    Toggle: (model, proposal) => ({
      rows: model.rows.map((row) => (row.id === proposal.id ? { id: row.id, on: !row.on } : row))
    })
  },
  reactors: [],
  state: (model) => ({
    controlState: "ready",
    on: model.rows.filter((row) => row.on).length,
    rows: model.rows
  }),
  nap: { ready: noIntent },
  actions: {
    Toggle: (intent) => Effect.succeed({ _tag: "Toggle", id: intent.id })
  }
})

export const ListPorts = makePorts(List)
