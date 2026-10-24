import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "loop",
  numeral: "I",
  title: "The Loop",
  subtitle: "one step, from the wish to the whisper",
  feature: "applyProposal · acceptors · reactors · state · nap",
  cues: [
    {
      line: "[The doors open on their own.] Eighteen seats and one box office. What you see is a real µFW loop, running live in this page.",
      spot: "house"
    },
    {
      line: "Click a seat. The click becomes an Intent, a request to hold that seat. The Model hasn't changed yet.",
      spot: "seats"
    },
    {
      line: "Click the held seat again to pay. The Action is where the program talks to the outside world, here the payment gateway, so it waits offstage.",
      spot: "st-action"
    },
    {
      line: "When the Action is done, it hands back a Proposal, a record of what happened. After a payment that's SeatSold, with the seat and who bought it.",
      spot: "st-proposal"
    },
    {
      line: "Now hold seat C6 and pay for it. The gateway always turns it down, and the answer comes back as a Proposal like any other, PaymentDeclined, with the reason.",
      spot: "seat-C6"
    },
    {
      line: "The Acceptors take a Proposal and decide how the Model changes. Each one reacts to its own kind of Proposal and ignores the rest. The fields that changed are listed below.",
      spot: "st-acceptors"
    },
    {
      line: "This is the real Acceptor for the last Proposal, quoted from the source. It takes the current Model and the Proposal, and returns the next Model.",
      spot: "code"
    },
    {
      line: "Hold a seat and leave it. After eight seconds the Reactors free it. They run after every Proposal and check whether any hold has run out.",
      spot: "st-reactors"
    },
    {
      line: "The State turns the Model into what the audience sees: the seats, the counts and a control state, such as selling or full.",
      spot: "st-state"
    },
    {
      line: "Last, NAP, the prompter, reads the State and whispers what should happen next: wait for the earliest hold to run out, or raise the curtain once all eighteen seats are sold.",
      spot: "st-nap"
    }
  ]
}
