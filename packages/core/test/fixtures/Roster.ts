import { Effect, Schema } from "effect"
import { define, noIntent } from "../../src/index.ts"

/** An ordered list of ids: the parent of a collection that holds one counter per id. */
export const Roster = define({
  name: "roster",
  model: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  proposal: Schema.Union([
    Schema.TaggedStruct("Added", { id: Schema.String }),
    Schema.TaggedStruct("Removed", { id: Schema.String })
  ]),
  intent: Schema.Union([
    Schema.TaggedStruct("Add", { id: Schema.String }),
    Schema.TaggedStruct("Remove", { id: Schema.String })
  ]),
  representation: Schema.Struct({
    controlState: Schema.Literals(["empty", "listed"]),
    ids: Schema.Array(Schema.String)
  })
})({
  initial: { ids: [] },
  acceptors: {
    Added: (model, proposal) => model.ids.includes(proposal.id) ? model : { ids: [...model.ids, proposal.id] },
    Removed: (model, proposal) => ({ ids: model.ids.filter((id) => id !== proposal.id) })
  },
  reactors: [],
  state: (model) => ({ controlState: model.ids.length === 0 ? "empty" : "listed", ids: model.ids }),
  nap: { empty: noIntent, listed: noIntent },
  actions: {
    Add: (intent) => Effect.succeed({ _tag: "Added", id: intent.id }),
    Remove: (intent) => Effect.succeed({ _tag: "Removed", id: intent.id })
  }
})
