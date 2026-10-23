import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "map",
  numeral: "III",
  title: "The Map",
  subtitle: "every place the show can stand, drawn before anyone walks it",
  feature: "exploreGraph · shortestPaths · mergeHistory · toXStateDefinition",
  cues: [
    { line: "[A stage manager kneels with a stick of chalk.] Before anyone walks, exploreGraph tries a few proposals from every state and draws what comes of them.", spot: "floor" },
    { line: "Count what it found: every state the Box Office can be in, folded onto a handful of places to stand.", spot: "count" },
    { line: "A spike mark is a control state. Nothing in the model says where it sits on the floor; the stage manager placed these four by hand.", spot: "node-selling" },
    { line: "A chalk arc is a proposal. DoorsOpened is the only way out of the dark, and the arc that says so was never typed in: it was found.", spot: "edge-DoorsOpened-dark-selling" },
    { line: "[A light begins to walk.] shortestPaths gives one route to every place. NAP whispers the next step for as long as a route remains.", spot: "floor" },
    { line: "The routes are written down as stage directions, one run of identical steps to a line.", spot: "walk" },
    { line: "Now the other map: the one you made. mergeHistory lays the records of Act I over the chalk, and every arc you crossed lights green, with a count.", spot: "mine" },
    { line: "A dashed red arc is a crossing the exploration never tried. Decline a payment in Act I (seat C6 is superstitious) and the map has to admit it.", spot: "mine" },
    { line: "The same map, as Stately reads it: toXStateDefinition turns the graph into a machine config you can paste into a visualiser.", spot: "xstate" },
    { line: "Last, unreachableControlStates: a place the definition declares and the exploration could never reach. Tonight, none.", spot: "unreachable" }
  ]
}
