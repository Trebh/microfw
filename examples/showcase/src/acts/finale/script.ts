import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "finale",
  numeral: "",
  title: "Finale",
  subtitle: "curtain call: what it costs, and tonight's record",
  feature: "HistoryPort · records · travelTo",
  cues: [
    { line: "[Applause. The company comes forward.]", spot: null },
    {
      line: "Before the house lights come up, the bill. µFW has a cost, and here it is, measured against the same pages written with uhtml alone.",
      spot: "bill"
    },
    {
      line: "Size and loading first. The counter is 42.8 KiB with µFW against 3.3 KiB with uhtml alone, and it appears after 38.6 ms instead of 16.7 ms on a slowed-down processor.",
      spot: "bill-weight"
    },
    {
      line: "Speed next. A click shows its result as fast as in the plain page, 15.2 ms against 15.3 ms. Each update costs a few millionths of a second more.",
      spot: "bill-speed"
    },
    {
      line: "On a server, each definition applies updates one at a time, in order: at most 7701 a second in our test. With 1000 viewers, an update takes 138.66 ms to reach them.",
      spot: "bill-server"
    },
    {
      line: "Against other frameworks, on the field's common 1000-row test: 1.43 times hand-written JavaScript, where plain uhtml takes 1.36. And 2.106 MiB of memory left after clearing the rows, against 0.770.",
      spot: "bill-field"
    },
    {
      line: "In return, every step is checked and recorded, and the same code can run in the browser, in a worker or on a server.",
      spot: "bill-total"
    },
    { line: "While you watched, the deck and the box office each counted the steps they took. Here are the totals.", spot: "tally" },
    {
      line: "[A pause.] Everything you did tonight was recorded. Press B to open the prompter's book and see the whole show.",
      spot: "reveal"
    },
    { line: "The company, in order of appearance. The earlier a player came on, the more faded the name.", spot: "credits" },
    { line: "[The house lights come up. Thank you, and good night.]", spot: null }
  ]
}
