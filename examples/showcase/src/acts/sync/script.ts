import type { ActScript } from "../../act.ts"

/** The cue on which the stage manager sends both windows after the same seat. */
export const RACE_CUE = 2

/** The cue on which the same race runs again over the slow line to window B. */
export const SLOW_RACE_CUE = 5

/** The cue on which window A is closed and the chair changes hands. */
export const CLOSE_CUE = 7

export const script: ActScript = {
  id: "sync",
  numeral: "VII",
  title: "Two Box Offices",
  subtitle: "two windows, one house, one ordered log",
  feature: "@mufw/core/sync · layerLoopSynced · SyncLog · the lease",
  cues: [
    {
      line: "Two ticket windows face each other across one house. Same definition, two loops, and not one shared variable.",
      spot: "windows"
    },
    {
      line: "Between them runs the log: ordered, append-only. Every entry has a sequence, and both windows read it from the top.",
      spot: "log"
    },
    {
      line: "[Both windows reach for the same seat in the same instant.] Two intents, two actions, two proposals, each sent to the log.",
      spot: "windows"
    },
    {
      line: "The log picks an order. The first proposal takes the seat; the second meets the same acceptor, and is refused, on both windows alike.",
      spot: "log"
    },
    {
      line: "The badge is not a hope. It compares the two models at the same sequence, and says agreed only when they are equal.",
      spot: "agreed"
    },
    {
      line: "[The line to window B goes slow. B asks first.] Its proposal is still on the wire: A's lands first and wins, and B converges when its own arrives.",
      spot: "slow-line"
    },
    {
      line: "One part needs a single owner: the prompter's chair. Automatic actions, like the wait that frees a hold, run only in the window that holds the lease.",
      spot: "lease"
    },
    {
      line: "[Window A closes.] Its renewals stop. After the timeout of silence, B claims the next epoch, and the chair is B's.",
      spot: "lease"
    },
    {
      line: "Only proposals travel. Each action ran where its intent arrived, A's hold at A, B's hold at B; the log never saw an intent.",
      spot: "log"
    }
  ]
}
