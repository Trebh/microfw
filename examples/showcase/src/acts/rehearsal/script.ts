import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "rehearsal",
  numeral: "IV",
  title: "Rehearsal",
  subtitle: "every path of the graph, run once, before the audience arrives",
  feature: "@mufw/test · createTestModel · shortestPaths · PathFailure",
  cues: [
    { line: "[A rehearsal room. The stage manager pins up the call sheet.] One line for every state of the Box Office, and each line is a way of getting there.", spot: "call-sheet" },
    { line: "Nobody wrote these lines. exploreGraph walked the pure definition and found the states; shortestPaths turned that graph into this sheet.", spot: "graph" },
    { line: "[Enter the understudy.] A second Box Office: its own loop, its own ports. No gateway, no waiting for a hold to run out; the test presents each step's proposal to it directly.", spot: "bench" },
    { line: "[Rehearse.] testModel.run goes back to seq 0, takes each step, and checks the state it reaches against the assertion that state is held to.", spot: "call-sheet" },
    { line: "The stage manager is a loop too. RunPath is an intent, PathPassed or PathFailed its proposal, and nap calls the next line.", spot: "controls" },
    { line: "[The last line is ticked.] Every path walked, every state as promised. The total reads clean.", spot: "total" },
    { line: "[A saboteur slips in.] Same schemas, same acceptors, one broken rule: a full house now reports itself as selling. Rehearse again.", spot: "sabotage" },
    { line: "Caught. PathFailure names the target, the step, what the model expected and what the house said, and the stage manager pins it to the line.", spot: "failure" },
    { line: "A test is a path the audience never has to walk.", spot: null }
  ]
}
