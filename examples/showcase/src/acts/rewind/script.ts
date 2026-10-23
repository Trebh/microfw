import type { ActScript } from "../../act.ts"

/** The cue that sends the stage back to the doors opening, through `layerForward`. */
export const returnCue = 3

export const script: ActScript = {
  id: "rewind",
  numeral: "II",
  title: "Rewind",
  subtitle: "everything that happened is on the reel",
  feature: "HistoryPort · travelTo · replayFrom · encodeHistoryJson",
  cues: [
    {
      line: "[A projector warms. The house you filled in Act I has been filmed, record by record.]",
      spot: "film"
    },
    {
      line: "Every step is a frame: the proposal that caused it, and the house as it stood after. The older the frame, the more its print has faded.",
      spot: "frame-latest"
    },
    {
      line: "This is the newest frame, enlarged: the stage as it is. Touch it and a frame is exposed. Nothing here is a copy.",
      spot: "stage"
    },
    {
      line: "Now go back. travelTo(seq) restores the model recorded under a seq. [The stage rewinds to the doors opening; the seats you held are free again.]",
      spot: "scrubber"
    },
    {
      line: "And the journey is itself a frame, a splice in the film. A travel is a new record: history never forgets it went back.",
      spot: "never-forgets"
    },
    {
      line: "A travel also stops what was running offstage. A hold waits for its expiry in an automatic action; travel away and that wait is interrupted, until the next proposal wakes the prompter.",
      spot: "hold-wait"
    },
    {
      line: "Same proposals, same play. replayFrom re-applies every proposal after a frame, as a pure function, and each model comes out equal to the one on the reel.",
      spot: "replay"
    },
    {
      line: "Take the recording home. encodeHistoryJson turns the whole reel into a file that decodeHistoryJson accepts. [A file lands in your downloads.]",
      spot: "export"
    }
  ]
}
