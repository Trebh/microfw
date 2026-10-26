import { assert, describe, it } from "@effect/vitest"
import {
  acceptAdvanced,
  acceptAutoplayToggled,
  acceptCueElapsed,
  acceptInterrupted,
  acceptJumped,
  acceptRetreated,
  advance,
  Deck,
  initialModel,
  jump,
  type Model,
  programOf,
  type ProgramAct,
  readingMillis,
  retreat,
  state
} from "../src/deck/Deck.ts"

const program: ReadonlyArray<ProgramAct> = [
  { id: "overture", cues: 3, readings: [4000, 5000, 6000] },
  { id: "loop", cues: 2, readings: [7000, 8000] },
  { id: "finale", cues: 1, readings: [9000] }
]

const at = (actIndex: number, cue: number, autoplay = false): Model => ({ acts: program, actIndex, cue, autoplay })

describe("advance", () => {
  it("moves to the next cue inside an act", () => {
    assert.deepStrictEqual(advance(at(0, 0)), at(0, 1))
  })

  it("moves from an act's last cue to the next act's first", () => {
    assert.deepStrictEqual(advance(at(0, 2)), at(1, 0))
  })

  it("stays on the last cue of the last act", () => {
    assert.deepStrictEqual(advance(at(2, 0)), at(2, 0))
  })
})

describe("retreat", () => {
  it("moves to the previous cue inside an act", () => {
    assert.deepStrictEqual(retreat(at(1, 1)), at(1, 0))
  })

  it("moves from an act's first cue to the previous act's last", () => {
    assert.deepStrictEqual(retreat(at(1, 0)), at(0, 2))
  })

  it("stays on the first cue of the first act", () => {
    assert.deepStrictEqual(retreat(at(0, 0)), at(0, 0))
  })
})

describe("jump", () => {
  it("goes to the named act at the named cue", () => {
    assert.deepStrictEqual(jump(at(0, 0), "loop", 1), at(1, 1))
  })

  it("clamps a cue past the act's last", () => {
    assert.deepStrictEqual(jump(at(0, 0), "loop", 9), at(1, 1))
  })

  it("clamps a negative cue to the first", () => {
    assert.deepStrictEqual(jump(at(1, 1), "overture", -4), at(0, 0))
  })

  it("ignores an unknown act", () => {
    assert.deepStrictEqual(jump(at(1, 1), "encore", 0), at(1, 1))
  })
})

describe("acceptors", () => {
  it("accept an Advanced proposal by advancing", () => {
    assert.deepStrictEqual(acceptAdvanced(at(0, 2)), at(1, 0))
  })

  it("accept a Retreated proposal by retreating", () => {
    assert.deepStrictEqual(acceptRetreated(at(1, 0)), at(0, 2))
  })

  it("accept a Jumped proposal by jumping", () => {
    assert.deepStrictEqual(acceptJumped(at(0, 0), { _tag: "Jumped", actId: "finale", cue: 0 }), at(2, 0))
  })

  it("toggle autoplay", () => {
    assert.deepStrictEqual(acceptAutoplayToggled(at(0, 0)), at(0, 0, true))
  })

  it("stop autoplay when interrupted", () => {
    assert.deepStrictEqual(acceptInterrupted(at(0, 1, true)), at(0, 1, false))
  })
})

describe("acceptCueElapsed", () => {
  it("advances when the cue that was read is still up and autoplay is on", () => {
    assert.deepStrictEqual(acceptCueElapsed(at(0, 1, true), { _tag: "CueElapsed", act: "overture", cue: 1 }), at(0, 2, true))
  })

  it("keeps the cue when the audience already moved on", () => {
    assert.deepStrictEqual(acceptCueElapsed(at(0, 2, true), { _tag: "CueElapsed", act: "overture", cue: 1 }), at(0, 2, true))
  })

  it("keeps the cue when autoplay was switched off meanwhile", () => {
    assert.deepStrictEqual(acceptCueElapsed(at(0, 1), { _tag: "CueElapsed", act: "overture", cue: 1 }), at(0, 1))
  })

  it("keeps the cue when the same cue number belongs to another act", () => {
    assert.deepStrictEqual(acceptCueElapsed(at(1, 1, true), { _tag: "CueElapsed", act: "overture", cue: 1 }), at(1, 1, true))
  })
})

describe("state", () => {
  it("is presenting at the start, with no progress", () => {
    assert.deepStrictEqual(state(at(0, 0)), {
      controlState: "presenting",
      actId: "overture",
      actIndex: 0,
      cue: 0,
      cueCount: 3,
      actCount: 3,
      progress: 0,
      autoplay: false,
      readingMillis: 4000
    })
  })

  it("is autoplay while the prompter runs the show", () => {
    assert.strictEqual(state(at(1, 0, true)).controlState, "autoplay")
  })

  it("is ended on the last cue of the last act, even with autoplay on", () => {
    assert.strictEqual(state(at(2, 0, true)).controlState, "ended")
  })

  it("has full progress on the last cue", () => {
    assert.strictEqual(state(at(2, 0)).progress, 1)
  })

  it("measures progress over every cue of the program", () => {
    assert.strictEqual(state(at(1, 0)).progress, 0.6)
  })
})

describe("nap", () => {
  it("whispers the reading of the current cue while autoplay is on", () => {
    assert.deepStrictEqual(
      Deck.nap(state(at(1, 1, true))),
      [{ _tag: "AwaitCue", act: "loop", cue: 1, millis: 8000 }]
    )
  })

  it("stays silent while autoplay is off", () => {
    assert.deepStrictEqual(Deck.nap(state(at(1, 1))), [])
  })

  it("stays silent at the end even with autoplay on", () => {
    assert.deepStrictEqual(Deck.nap(state(at(2, 0, true))), [])
  })
})

describe("the program", () => {
  it("is read from the scripts: a cue count and a reading per cue", () => {
    const scripts = [
      {
        id: "overture",
        numeral: "",
        title: "Overture",
        subtitle: "",
        feature: "",
        cues: [{ line: "", spot: null }, { line: "x".repeat(10), spot: null }]
      }
    ]
    assert.deepStrictEqual(programOf(scripts), [{ id: "overture", cues: 2, readings: [3500, 4050] }])
  })

  it("starts at the act the hash names", () => {
    assert.strictEqual(initialModel(program, "#loop").actIndex, 1)
  })

  it("starts at the first act when the hash names none", () => {
    assert.strictEqual(initialModel(program, "#intermission").actIndex, 0)
  })

  it("never reads a line for less than the minimum or more than the maximum", () => {
    assert.deepStrictEqual([readingMillis(""), readingMillis("x".repeat(1000))], [3500, 14_000])
  })
})
