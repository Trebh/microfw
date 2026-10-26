import { assert, describe, it } from "@effect/vitest"
import { emptyTally, tally } from "../src/acts/finale/tally.ts"

describe("tally", () => {
  it("does not count a history's opening record as a step", () => {
    assert.deepStrictEqual(tally(emptyTally, { source: "deck", kind: "init" }), { deck: 0, stage: 0, rewinds: 0 })
  })

  it("counts a deck step for the deck", () => {
    assert.deepStrictEqual(tally(emptyTally, { source: "deck", kind: "step" }), { deck: 1, stage: 0, rewinds: 0 })
  })

  it("counts a box office step for the stage", () => {
    assert.deepStrictEqual(tally(emptyTally, { source: "stage", kind: "step" }), { deck: 0, stage: 1, rewinds: 0 })
  })

  it("counts a travel of either loop as a rewind and not as a step", () => {
    assert.deepStrictEqual(tally(emptyTally, { source: "stage", kind: "travel" }), { deck: 0, stage: 0, rewinds: 1 })
  })

  it("counts a restore from the event log's snapshot as neither a step nor a rewind", () => {
    assert.deepStrictEqual(tally(emptyTally, { source: "stage", kind: "restore" }), { deck: 0, stage: 0, rewinds: 0 })
  })
})
