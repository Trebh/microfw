import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "loop",
  numeral: "I",
  title: "The Loop",
  subtitle: "one step, from the wish to the whisper",
  feature: "applyProposal · acceptors · reactors · state · nap",
  cues: [
    {
      line: "[The doors open on their own.] Eighteen seats and one box office. It is a real loop, running in this page: nothing here is a recording.",
      spot: "house"
    },
    {
      line: "Pick a seat. That click is an Intent: a wish, not a fact. Nothing in the model has moved yet.",
      spot: "seats"
    },
    {
      line: "Hold a seat, then pay for it. While the gateway thinks, the Action stands offstage: the only place where anything is allowed to happen.",
      spot: "st-action"
    },
    {
      line: "What the Action brings back is a Proposal: a plain fact. Not \"sell C4\", but SeatSold, with the seat and the patron.",
      spot: "st-proposal"
    },
    {
      line: "Try C6. The gateway is superstitious, and its refusal comes back as a Proposal too: PaymentDeclined, with its reason. A refusal is a fact, not an error.",
      spot: "seat-C6"
    },
    {
      line: "The Acceptors alone decide what the Model becomes. Each handles its own tag and hands everything else back untouched. The fields they changed are listed beside.",
      spot: "st-acceptors"
    },
    {
      line: "This is the real acceptor of the last proposal, quoted from the source. A model and a proposal go in; a model comes out; nothing else is allowed.",
      spot: "code"
    },
    {
      line: "Hold a seat and leave it. Eight seconds later the Reactors free it, whoever is watching. They run after every proposal, and keep one thing true: no hold outlives its time.",
      spot: "st-reactors"
    },
    {
      line: "The State turns the model into a representation: seats, counts, a control state. It is all the audience ever sees.",
      spot: "st-state"
    },
    {
      line: "And NAP, the prompter, reads that representation and whispers the next line: wait for the earliest hold, or, with all eighteen sold, raise the curtain.",
      spot: "st-nap"
    }
  ]
}
