import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "overture",
  numeral: "",
  title: "Overture",
  subtitle: "the playbill and its cast",
  feature: "define · makePorts · layerLoopLocal",
  cues: [
    { line: "[The house lights fall. One light, on the name.]", spot: "title" },
    { line: "µFW is a play for one model and any number of stages.", spot: "subtitle" },
    { line: "Eight players. Learn their names and you know the whole framework. The first is The Intent: what the audience asks for.", spot: "cast-intent" },
    { line: "The Action is the only one allowed offstage. Every effect of the evening happens there, and nowhere else.", spot: "cast-action" },
    { line: "What the Action brings back is a Proposal: a plain fact, handed to the stage.", spot: "cast-proposal" },
    { line: "The Acceptors alone decide what the Model becomes. They may take a proposal whole, in part, or not at all.", spot: "cast-acceptors" },
    { line: "The Reactors tidy the stage after every scene: whatever must stay true, they make true.", spot: "cast-reactors" },
    { line: "The Model is the keeper of truth. Nobody else holds any.", spot: "cast-model" },
    { line: "The State turns the model into a representation: the one thing the audience ever sees.", spot: "cast-state" },
    { line: "And NAP, the prompter, who reads the representation and whispers the next line, if there is one.", spot: "cast-nap" },
    { line: "To drive the show, use the keys: the arrows move the story, 1–9 jump to an act, A hands the show to the prompter, B opens the prompter's book.", spot: "hints" },
    { line: "[The curtain is about to rise on Act I.]", spot: null }
  ]
}
