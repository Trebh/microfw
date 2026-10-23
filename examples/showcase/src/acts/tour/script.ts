import type { ActScript } from "../../act.ts"

export const script: ActScript = {
  id: "tour",
  numeral: "V",
  title: "On Tour",
  subtitle: "the same play on three stages",
  feature: "layers decide placement: layerLoopLocal · RPC over a web worker · RPC client",
  cues: [
    { line: "[Three stages, side by side, one play.] The definition did not change. Only the layers did.", spot: "banner" },
    { line: "In the house: layerLoopLocal. The intent, the action, the acceptors and the model all run in this page, in this thread. [Press a seat.]", spot: "house" },
    { line: "In the wings: the same definition in a dedicated web worker. The page holds three remote ports, and a message channel stands where the model was.", spot: "wings" },
    { line: "Across town: an RPC client wired to a server's handlers, over a road that does not exist. The 180 ms is a stand-in, and the card says so.", spot: "town" },
    { line: "Look at the imports. The definition and the view are imported, identically, by all three. None of them knows where it is standing.", spot: "imports" },
    { line: "What differs is a handful of lines at each composition root: a loop, a worker, a client. The acceptors, the actions and the seat map stay put.", spot: "stages" },
    { line: "[The stage manager presses seat B3 on all three stages at once.] Each stopwatch reads Clock from the press to the representation that shows it. Compare.", spot: "meters" },
    { line: "Placement is decided at the composition root, never by the audience. Nobody in the house was asked where the play would run.", spot: "banner" }
  ]
}
