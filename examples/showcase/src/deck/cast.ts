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
  { id: "intent", name: "The Intent", role: "what the audience asks for", code: "intent" },
  { id: "action", name: "The Action", role: "the only one allowed offstage", code: "actions" },
  { id: "proposal", name: "The Proposal", role: "what the action brings back onstage", code: "proposal" },
  { id: "acceptors", name: "The Acceptors", role: "who decide what the model becomes", code: "acceptors" },
  { id: "reactors", name: "The Reactors", role: "who tidy the stage after every scene", code: "reactors" },
  { id: "model", name: "The Model", role: "the keeper of truth", code: "model" },
  { id: "state", name: "The State", role: "turns the model into a representation the audience sees", code: "state" },
  { id: "nap", name: "NAP", role: "the prompter, who whispers the next line", code: "nap" }
]
