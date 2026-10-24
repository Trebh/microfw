import { define, makePorts } from "@mufw/core"
import { Effect, Option, Random, Schema } from "effect"
import { makeLabels } from "./labels.ts"
import { CREATE_COUNT, CREATE_LOTS_COUNT, swapRows, updateEveryTenth, withLabels } from "./rows.ts"

const Row = Schema.Struct({ id: Schema.Int, label: Schema.String })

const Selection = Schema.NullOr(Schema.Int)

const Model = Schema.Struct({ rows: Schema.Array(Row), selected: Selection, nextId: Schema.Int })
type Model = typeof Model.Type

const Intent = Schema.Union([
  Schema.TaggedStruct("Run", {}),
  Schema.TaggedStruct("RunLots", {}),
  Schema.TaggedStruct("Add", {}),
  Schema.TaggedStruct("Update", {}),
  Schema.TaggedStruct("Clear", {}),
  Schema.TaggedStruct("SwapRows", {}),
  Schema.TaggedStruct("Select", { id: Schema.Int }),
  Schema.TaggedStruct("Remove", { id: Schema.Int })
])

const Proposal = Schema.Union([
  Schema.TaggedStruct("Replaced", { labels: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Appended", { labels: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Updated", {}),
  Schema.TaggedStruct("Cleared", {}),
  Schema.TaggedStruct("Swapped", {}),
  Schema.TaggedStruct("Selected", { id: Schema.Int }),
  Schema.TaggedStruct("Removed", { id: Schema.Int })
])

const Representation = Schema.Struct({
  controlState: Schema.Literals(["ready"]),
  rows: Schema.Array(Row),
  selected: Selection
})

const replaceRows = (model: Model, proposal: typeof Proposal.Type): Model =>
  proposal._tag === "Replaced"
    ? {
      rows: withLabels(model.nextId, proposal.labels),
      selected: null,
      nextId: model.nextId + proposal.labels.length
    }
    : model

const appendRows = (model: Model, proposal: typeof Proposal.Type): Model =>
  proposal._tag === "Appended"
    ? {
      rows: model.rows.concat(withLabels(model.nextId, proposal.labels)),
      selected: model.selected,
      nextId: model.nextId + proposal.labels.length
    }
    : model

const updateRows = (model: Model, proposal: typeof Proposal.Type): Model =>
  proposal._tag === "Updated" ? { ...model, rows: updateEveryTenth(model.rows) } : model

const clearRows = (model: Model, proposal: typeof Proposal.Type): Model =>
  proposal._tag === "Cleared" ? { ...model, rows: [], selected: null } : model

const swapRowsAt = (model: Model, proposal: typeof Proposal.Type): Model =>
  proposal._tag === "Swapped" ? { ...model, rows: swapRows(model.rows) } : model

const selectRow = (model: Model, proposal: typeof Proposal.Type): Model =>
  proposal._tag === "Selected" ? { ...model, selected: proposal.id } : model

const removeRow = (model: Model, proposal: typeof Proposal.Type): Model =>
  proposal._tag === "Removed" ? { ...model, rows: model.rows.filter((row) => row.id !== proposal.id) } : model

/** Drawing labels is the one impure step: it reads the `Random` service, and its result travels in the proposal. */
const draw = (count: number) =>
  Effect.gen(function*() {
    const random = yield* Random.Random
    return makeLabels(count, () => random.nextDoubleUnsafe())
  })

/** The js-framework-benchmark table as a SAM definition: rows, the selected id and the next id to hand out. */
export const Table = define({
  name: "jfbTable",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  controlStates: ["ready"],
  initial: { rows: [], selected: null, nextId: 1 },
  acceptors: [replaceRows, appendRows, updateRows, clearRows, swapRowsAt, selectRow, removeRow],
  reactors: [],
  state: (model) => ({ controlState: "ready", rows: model.rows, selected: model.selected }),
  nap: () => Option.none(),
  actions: {
    Run: () => Effect.map(draw(CREATE_COUNT), (labels) => ({ _tag: "Replaced", labels })),
    RunLots: () => Effect.map(draw(CREATE_LOTS_COUNT), (labels) => ({ _tag: "Replaced", labels })),
    Add: () => Effect.map(draw(CREATE_COUNT), (labels) => ({ _tag: "Appended", labels })),
    Update: () => Effect.succeed({ _tag: "Updated" }),
    Clear: () => Effect.succeed({ _tag: "Cleared" }),
    SwapRows: () => Effect.succeed({ _tag: "Swapped" }),
    Select: (intent) => Effect.succeed({ _tag: "Selected", id: intent.id }),
    Remove: (intent) => Effect.succeed({ _tag: "Removed", id: intent.id })
  }
})

export const TablePorts = makePorts(Table)
