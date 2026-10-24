import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "overture",
  numeral: "",
  title: "Overture",
  subtitle: "meet the eight players",
  feature: "define · makePorts · layerLoopLocal",
  cues: [
    { line: "[The house lights fall. One light shines on the name.]", spot: "title" },
    { line: "µFW is a framework built around one model. Wherever the program runs is its stage: a browser, a server or a test.", spot: "subtitle" },
    { line: "Eight players make up the whole framework. The first is the Intent: a request from the user, like a click on a seat.", spot: "cast-intent" },
    { line: "The Action does the work outside the program, such as charging a card. Anything that touches the outside world happens here.", spot: "cast-action" },
    { line: "When the Action finishes, it reports back with a Proposal: a plain statement of what happened, such as \"the card was declined\".", spot: "cast-proposal" },
    { line: "The Acceptors decide what goes into the Model. They can take a Proposal whole, take only part of it, or turn it down.", spot: "cast-acceptors" },
    { line: "After each change, the Reactors check that the rules your program depends on still hold, and fix the Model if they don't.", spot: "cast-reactors" },
    { line: "The Model holds your program's data. That data lives nowhere else, and only the Acceptors change it.", spot: "cast-model" },
    { line: "The State turns the Model into a representation: what the user sees on screen.", spot: "cast-state" },
    { line: "Last is NAP. It looks at that representation and, if something should happen next, starts the next Action by itself.", spot: "cast-nap" },
    { line: "Now you drive. The arrow keys step through the show, 1 to 9 jump to an act, A plays it for you, and B opens the prompter's book.", spot: "hints" },
    { line: "[The curtain is about to rise on Act I.]", spot: null }
  ]
}
