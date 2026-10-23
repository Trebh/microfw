import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "within",
  numeral: "VI",
  title: "A Play Within a Play",
  subtitle: "two ways to compose definitions: nest, and layerForward",
  feature: "nest · layerForward · proposalLabel",
  cues: [
    {
      line: "[Elsinore. Hamlet has the players stage a play inside the play, to catch a king.] On the left, The Mousetrap: a box office, staged inside the house that owns the lights.",
      spot: "proscenium"
    },
    {
      line: "nest(House, Mousetrap) is one definition: one model { parent, child }, one intent queue, one loop, one view. Its control state reads both halves.",
      spot: "model"
    },
    {
      line: "Forwarding happens inside the step. [The stage manager dims the house.] The doors of the inner play open in that same record. Now raise its curtain: the house goes darker in the same one.",
      spot: "controls"
    },
    {
      line: "One history for both. Child/SeatHeld and LightsDimmed are rows of one list, one seq apiece, and one travelTo would rewind the house and the play together.",
      spot: "history-nest"
    },
    {
      line: "[The other way to stage it.] On the right, two islands: FrontOfHouse is a box office, the Marquee is a sign. Two definitions, two models, two loops, joined by one layer.",
      spot: "islands"
    },
    {
      line: "layerForward is a function: the previous and the current representation in, an intent out. It answers none when nothing the sign cares about has changed.",
      spot: "forward-code"
    },
    {
      line: "Two islands, two histories. The box office counts its steps, the marquee its repaints, and a repaint is a step of its own, after the one that caused it. [Hold every seat.]",
      spot: "histories"
    },
    {
      line: "The choice: nest what must change together, in one step. Forward between what only watches, and may stand somewhere else.",
      spot: "compare"
    }
  ]
}
