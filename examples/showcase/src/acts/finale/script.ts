import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "finale",
  numeral: "",
  title: "Finale",
  subtitle: "curtain call: the bill, and the recorded show",
  feature: "HistoryPort · records · travelTo",
  cues: [
    { line: "[Applause. The company comes forward.]", spot: null },
    { line: "Before the house lights come up, the bill. µFW is not free, and the programme says so.", spot: "bill" },
    { line: "Weight first: about twenty times the JavaScript of the plain page, and two to three times as long to first content.", spot: "bill-weight" },
    { line: "Then speed: a click is shown in the same task as in the plain page, and a step costs a few microseconds over the reducer it runs.", spot: "bill-speed" },
    { line: "And the server: one definition is one serialised writer, so more connections do not mean more proposals per second.", spot: "bill-server" },
    { line: "What you pay for is a loop that is typed, recorded, and can stand wherever you put it.", spot: "bill-total" },
    { line: "While you watched, two loops kept count of every step they took.", spot: "tally" },
    { line: "[A pause.] Everything you did tonight was recorded. Press B: the whole show is in the prompter's book.", spot: "reveal" },
    { line: "The company, in order of appearance. The earliest are the furthest in the past.", spot: "credits" },
    { line: "[The house lights come up. Thank you, and good night.]", spot: null }
  ]
}
