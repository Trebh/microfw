import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "rehearsal",
  numeral: "IV",
  title: "Rehearsal",
  subtitle: "a test that walks every state of the Box Office",
  feature: "@mufw/test · createTestModel · shortestPaths · PathFailure",
  cues: [
    { line: "[A rehearsal room. The stage manager pins up the call sheet.] This is the test. Each line is the shortest way to reach one state of the Box Office.", spot: "call-sheet" },
    { line: "Nobody wrote these lines. The test library explored the Box Office's definition, found every state it can reach, and worked out the shortest path to each.", spot: "graph" },
    { line: "[Enter the understudy.] A second Box Office for the test to use. It has no payment gateway and never waits for a hold to expire; the test hands it each step's Proposal directly.", spot: "bench" },
    { line: "[Rehearse.] For each line, the test goes back to the start, takes the steps one by one, and checks what the Box Office shows when it arrives.", spot: "call-sheet" },
    { line: "The stage manager runs on a loop too. For each line it sends a RunPath Intent, gets PathPassed or PathFailed back as the Proposal, and NAP calls the next line.", spot: "controls" },
    { line: "[The last line is ticked.] Every path passed: each state looked the way the test expected. The total at the bottom says so.", spot: "total" },
    { line: "[A saboteur slips in.] This understudy has one broken rule: with no seat free, it still says it is selling. Everything else is the same. Rehearse it again.", spot: "sabotage" },
    { line: "Caught. The test reports a PathFailure with the target state, the step, what it expected and what it found, and the stage manager pins it to the line.", spot: "failure" },
    { line: "[Applause.] That is a model-based test: the library finds every state, walks the shortest way to each, and checks what the page shows there.", spot: null }
  ]
}
