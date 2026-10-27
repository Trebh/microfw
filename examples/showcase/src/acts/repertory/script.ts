import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "repertory",
  numeral: "VII",
  title: "In Repertory",
  subtitle: "one program, as many parts as the bill lists: compose",
  feature: "compose · part.collection · toParent · fromParent",
  cues: [
    {
      line: "[A repertory house: one company, a season of nights, each night with a box office of its own.] The season is one program. compose(Season, Nights) puts a collection of box offices under it, on one loop.",
      spot: "bill"
    },
    {
      line: "Press Programme Fri, then Programme Sat. The season's model lists the nights, and the collection follows that list: a night on the bill is a box office in parts.Nights, started from BoxOffice.initial.",
      spot: "programme"
    },
    {
      line: "Press Open the season. One proposal, SeasonOpened. fromParent turns it into DoorsOpened for every night on the bill, inside the same step: one record in the history, every night selling.",
      spot: "open"
    },
    {
      line: "Hold a seat on Fri, then one on Sat. The record reads Nights[Fri]/SeatHeld: the key addresses the night.",
      spot: "nights"
    },
    {
      line: "Each hold expires on a timer of its own. Nights[Fri]/AwaitExpiry and Nights[Sat]/AwaitExpiry are two automatic actions in flight at once; each night lets go on its own clock.",
      spot: "history"
    },
    {
      line: "Press Raise curtain on Fri. CurtainRaised is the night's proposal; toParent turns it into NightPlayed for the season, which takes Fri off the bill. The box office is dropped in that same step. Its records stay in the history.",
      spot: "played"
    },
    {
      line: "Press Cancel on Sat. That is the other way a night leaves: the season's own proposal. A night cannot drop itself. Only the season's model lists the nights, and the collection follows it.",
      spot: "cancel"
    },
    {
      line: "Use compose when the parts are siblings, or when how many there are is decided while the program runs. Use nest for one part inside another. Use layerForward when the programs run apart.",
      spot: "compare"
    }
  ]
}
