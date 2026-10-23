import { define, makePorts } from "@mufw/core"
import { Effect, Option, Schema } from "effect"

/**
 * Whether the prompter's book is open. It is a loop of its own, not a field of the deck's model:
 * rewinding the deck through the book must not close the book it is rewound from.
 */
export const Model = Schema.Struct({ open: Schema.Boolean })
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("BookToggled", {}),
  Schema.TaggedStruct("BookClosed", {})
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("ToggleBook", {}),
  Schema.TaggedStruct("CloseBook", {})
])
export type Intent = typeof Intent.Type

export const Representation = Schema.Struct({
  controlState: Schema.Literals(["closed", "open"]),
  open: Schema.Boolean
})
export type Representation = typeof Representation.Type

export const acceptToggled = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "BookToggled" ? { open: !model.open } : model

export const acceptClosed = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "BookClosed" ? { open: false } : model

export const state = (model: Model): Representation => ({
  controlState: model.open ? "open" : "closed",
  open: model.open
})

export const Book = define({
  name: "Book",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  controlStates: ["closed", "open"],
  initial: { open: false },
  acceptors: [acceptToggled, acceptClosed],
  reactors: [],
  state,
  nap: () => Option.none(),
  actions: {
    ToggleBook: () => Effect.succeed({ _tag: "BookToggled" }),
    CloseBook: () => Effect.succeed({ _tag: "BookClosed" })
  }
})

export const BookPorts = makePorts(Book)
