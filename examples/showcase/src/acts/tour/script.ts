import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "tour",
  numeral: "V",
  title: "On Tour",
  subtitle: "the same play on three stages",
  feature: "layerLoopLocal · RPC over a web worker · RPC client",
  cues: [
    { line: "[Three stages, one play.] The same program runs on all three. Only the few lines that set it up are different.", spot: "banner" },
    { line: "On the first stage, everything runs in this page: the Intent, the Action, the Acceptors and the Model. [Click a seat.]", spot: "house" },
    { line: "On the second stage, the same program runs in a web worker, a separate thread. This page sends Intents to it and shows what comes back.", spot: "wings" },
    { line: "The third stage acts as if the program ran on a server. There is no server: it runs in this page, and the page adds a 180 ms wait to imitate the network.", spot: "town" },
    { line: "Look at the imports. All three stages import the same definition and the same seat map, and neither one knows where it is running.", spot: "imports" },
    { line: "What differs is the setup at the top of each card, a few lines that say where the program runs. The rules and the seat map stay as they are.", spot: "stages" },
    { line: "[The stage manager clicks seat B3 on all three stages at once.] Each stopwatch times the click until the screen shows the result. Compare the three.", spot: "meters" },
    { line: "Where the program runs is chosen in the setup code. Someone clicking a seat can't tell which stage they are on, except by the stopwatch.", spot: "banner" }
  ]
}
