/** One part of the SAM loop, cast as a player: who it is on the playbill, what it plays, and the code it stands for. */
export interface CastMember {
  readonly id: string
  readonly name: string
  readonly role: string
  /** The name of the part in a definition (`acceptors`, `nap`). */
  readonly code: string
}

/** The eight players, in order of appearance. The overture and the finale both list them. */
export const cast: ReadonlyArray<CastMember> = [
  { id: "intent", name: "The Intent", role: "a request from the user, like a click", code: "intent" },
  { id: "action", name: "The Action", role: "does the work outside the program", code: "actions" },
  { id: "proposal", name: "The Proposal", role: "what an action reports back", code: "proposal" },
  { id: "acceptors", name: "The Acceptors", role: "decide what goes into the model", code: "acceptors" },
  { id: "reactors", name: "The Reactors", role: "keep the model's rules true after each change", code: "reactors" },
  { id: "model", name: "The Model", role: "the data your program holds", code: "model" },
  { id: "state", name: "The State", role: "turns the model into what the user sees", code: "state" },
  { id: "nap", name: "NAP", role: "starts the next action when one is due", code: "nap" }
]
