import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "within",
  numeral: "VI",
  title: "A Play Within a Play",
  subtitle: "two ways to combine programs: nest and layerForward",
  feature: "nest · layerForward · proposalLabel",
  cues: [
    {
      line: "[Elsinore. Hamlet has the players stage a play inside the play.] On the left, The Mousetrap is a box office that sits inside a house with its own lights.",
      spot: "proscenium"
    },
    {
      line: "nest(House, Mousetrap) joins the house lights and the play into one program. Its model has two parts, and the label below reads both: lights/play.",
      spot: "model"
    },
    {
      line: "[The stage manager dims the house.] Dimming opens the play's doors in that same step. Now press Raise curtain: the house dims again in that step too.",
      spot: "controls"
    },
    {
      line: "Look at the list beside the play. House steps like LightsDimmed and play steps like Child/SeatHeld share one history, so travelTo could rewind both together.",
      spot: "history-nest"
    },
    {
      line: "[The other way to stage it.] On the right are two separate programs: FrontOfHouse, a box office, and the Marquee, a sign. layerForward connects them.",
      spot: "islands"
    },
    {
      line: "layerForward runs this function on every change in FrontOfHouse. It returns a repaint request for the sign, or nothing if the sign would read the same.",
      spot: "forward-code"
    },
    {
      line: "[Press Hold every seat.] Each program numbers its own steps. The box office logs the holds, and a moment later the sign logs its repaints in its own list.",
      spot: "histories"
    },
    {
      line: "Use nest for two parts that must change together. Use layerForward when one program only watches another, or when they run in different places. For more parts than two, or a number of them decided while the program runs: the next act.",
      spot: "compare"
    }
  ]
}
