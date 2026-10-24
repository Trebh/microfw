import type { ActScript } from "../../act.ts"

/** The cue that sends the stage back to the doors opening, through `layerForward`. */
export const returnCue = 3

export const script: ActScript = {
  id: "rewind",
  numeral: "II",
  title: "Rewind",
  subtitle: "every step is kept on the reel",
  feature: "HistoryPort · travelTo · replayFrom · encodeHistoryJson",
  cues: [
    {
      line: "[A projector warms. The house you filled in Act I was filmed, one frame for every step.]",
      spot: "film"
    },
    {
      line: "Each frame shows the proposal behind a step and the house as it stood afterwards. The older the frame, the more faded it looks.",
      spot: "frame-latest"
    },
    {
      line: "The big panel is the newest frame, enlarged. It's the live stage: click a seat and a new frame appears on the strip.",
      spot: "stage"
    },
    {
      line: "Now go back. travelTo jumps to any earlier step and restores the model as it was then. [The stage returns to the doors opening; your seats are free again.]",
      spot: "scrubber"
    },
    {
      line: "Going back is recorded too. The jump adds a new frame to the reel, so the history still shows that you went back.",
      spot: "never-forgets"
    },
    {
      line: "Going back also cancels work running offstage. A held seat waits for its time to run out, and that wait stops until the next proposal arrives.",
      spot: "hold-wait"
    },
    {
      line: "Replaying means applying the same proposals again and getting the same models. replayFrom does it from any frame, and each result should match the reel.",
      spot: "replay"
    },
    {
      line: "You can keep the recording. encodeHistoryJson turns the whole reel into a JSON file, and decodeHistoryJson reads it back. [A file lands in your downloads.]",
      spot: "export"
    }
  ]
}
