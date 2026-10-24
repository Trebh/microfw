import type { ActScript } from "../../act.ts"

/** The cue on which the stage manager sends both windows after the same seat. */
export const RACE_CUE = 2

/** The cue on which the same race runs again over the slow line to window B. */
export const SLOW_RACE_CUE = 5

/** The cue on which window A is closed and the lease changes hands. */
export const CLOSE_CUE = 7

export const script: ActScript = {
  id: "sync",
  numeral: "VII",
  title: "Two Box Offices",
  subtitle: "two windows, one house, one shared log",
  feature: "@mufw/core/sync · layerLoopSynced · SyncLog · the lease",
  cues: [
    {
      line: "Two ticket windows, one house. Each window runs the same box office on its own, and they share no variable.",
      spot: "windows"
    },
    {
      line: "Between them is the log, one shared list of numbered entries. Both windows write their proposals to its end, and both apply it from the top.",
      spot: "log"
    },
    {
      line: "[Both windows reach for the same seat at the same moment.] Each one turns its click into a proposal and sends it to the log.",
      spot: "windows"
    },
    {
      line: "The log puts the two proposals in a line. The first gets the seat, the second is refused, and both windows show the same result.",
      spot: "log"
    },
    {
      line: "The badge compares the two windows. It says agreed only when both have applied the same entries and hold the same seats.",
      spot: "agreed"
    },
    {
      line: "[The line to window B goes slow, and B asks first.] B's proposal is still on its way, so A's reaches the log first and wins. B catches up when its own arrives.",
      spot: "slow-line"
    },
    {
      line: "Some work must run in one window only. Automatic actions, like the timer that frees an unpaid hold, run only in the window that holds the lease.",
      spot: "lease"
    },
    {
      line: "[Window A closes.] It stops renewing the lease. After a few seconds of silence, window B takes the lease over and runs the automatic actions.",
      spot: "lease"
    },
    {
      line: "Only proposals go into the log. A's click was handled in window A and B's in window B; the log never sees a click.",
      spot: "log"
    }
  ]
}
