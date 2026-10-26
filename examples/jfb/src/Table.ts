import { define, makePorts, noIntent, type WithTag } from "@mufw/core"
import { Effect, Random, Schema } from "effect"
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
type Proposal = typeof Proposal.Type

const Representation = Schema.Struct({
  controlState: Schema.Literals(["ready"]),
  rows: Schema.Array(Row),
  selected: Selection
})

const acceptReplaced = (model: Model, proposal: WithTag<Proposal, "Replaced">): Model => ({
  rows: withLabels(model.nextId, proposal.labels),
  selected: null,
  nextId: model.nextId + proposal.labels.length
})

const acceptAppended = (model: Model, proposal: WithTag<Proposal, "Appended">): Model => ({
  rows: model.rows.concat(withLabels(model.nextId, proposal.labels)),
  selected: model.selected,
  nextId: model.nextId + proposal.labels.length
})

const acceptUpdated = (model: Model): Model => ({ ...model, rows: updateEveryTenth(model.rows) })

const acceptCleared = (model: Model): Model => ({ ...model, rows: [], selected: null })

const acceptSwapped = (model: Model): Model => ({ ...model, rows: swapRows(model.rows) })

const acceptSelected = (model: Model, proposal: WithTag<Proposal, "Selected">): Model => ({
  ...model,
  selected: proposal.id
})

const acceptRemoved = (model: Model, proposal: WithTag<Proposal, "Removed">): Model => ({
  ...model,
  rows: model.rows.filter((row) => row.id !== proposal.id)
})

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
  initial: { rows: [], selected: null, nextId: 1 },
  acceptors: {
    Replaced: acceptReplaced,
    Appended: acceptAppended,
    Updated: acceptUpdated,
    Cleared: acceptCleared,
    Swapped: acceptSwapped,
    Selected: acceptSelected,
    Removed: acceptRemoved
  },
  reactors: [],
  state: (model) => ({ controlState: "ready", rows: model.rows, selected: model.selected }),
  nap: { ready: noIntent },
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
