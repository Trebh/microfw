import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "map",
  numeral: "III",
  title: "The Map",
  subtitle: "every state the Box Office can reach, drawn before anyone uses it",
  feature: "exploreGraph · shortestPaths · mergeHistory · toXStateDefinition",
  cues: [
    { line: "[A stage manager kneels with a stick of chalk.] To draw the map, exploreGraph tries a few proposals from every state and records where each one leads.", spot: "floor" },
    { line: "Look at the count at the top. The Box Office can be in many states, but they group into just a few kinds of place to stand.", spot: "count" },
    { line: "Each circle is a control state of the Box Office, such as selling. Only where they sit on the floor was decided by hand. Everything else is drawn from the graph.", spot: "node-selling" },
    { line: "Each chalk arc is a proposal that moves the Box Office to another place. Nobody drew this one: the program found it. DoorsOpened is the only way out of dark.", spot: "edge-DoorsOpened-dark-selling" },
    { line: "[A light begins to walk.] shortestPaths finds the quickest route from the start to every place. The light walks them in turn; NAP keeps asking for the next step.", spot: "floor" },
    { line: "Each route is written as walk directions. When the same step repeats, it takes one line with a count.", spot: "walk" },
    { line: "Now your own map. mergeHistory takes the steps you made in Act I and lays them over the chalk. Every arc you crossed turns green, with the number of times.", spot: "mine" },
    { line: "A dashed red arc is a crossing the exploration never tried. To make one, decline a payment in Act I: the payment gateway always turns down seat C6.", spot: "mine" },
    { line: "The same map in the format XState uses. toXStateDefinition turns the graph into a machine config that you can paste into a visualiser such as Stately.", spot: "xstate" },
    { line: "One last question: does the definition declare a place that nothing can reach? unreachableControlStates answers it. Tonight, the answer is none.", spot: "unreachable" }
  ]
}
