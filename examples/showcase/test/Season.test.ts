import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { acceptNightPlayed, acceptNightProgrammed, type Model, state } from "../src/acts/repertory/Season.ts"

const season = (programme: ReadonlyArray<string>, played: ReadonlyArray<string>, openedAt: Option.Option<number>): Model => ({
  programme,
  played,
  openedAt
})

describe("Season acceptors", () => {
  it("a night already on the bill is not programmed twice", () => {
    const model = season(["Fri"], [], Option.none())

    const next = acceptNightProgrammed(model, { _tag: "NightProgrammed", night: "Fri" })

    assert.deepStrictEqual(next, season(["Fri"], [], Option.none()))
  })

  it("a night played leaves the bill and is listed as played", () => {
    const model = season(["Fri", "Sat"], [], Option.some(1_000))

    const next = acceptNightPlayed(model, { _tag: "NightPlayed", night: "Fri" })

    assert.deepStrictEqual(next, season(["Sat"], ["Fri"], Option.some(1_000)))
  })
})

describe("Season state", () => {
  it("offers the first night neither on the bill nor played", () => {
    const representation = state(season(["Sat"], ["Fri"], Option.none()))

    assert.deepStrictEqual(representation.next, Option.some("Sun"))
  })

  it("offers no night once every night is on the bill or played", () => {
    const representation = state(season(["Sat", "Sun"], ["Fri"], Option.none()))

    assert.deepStrictEqual(representation.next, Option.none())
  })

  it("is planning before the season opens, even with nights on the bill", () => {
    const representation = state(season(["Fri"], [], Option.none()))

    assert.strictEqual(representation.controlState, "planning")
  })

  it("is open once opened with a night on the bill", () => {
    const representation = state(season(["Sat"], ["Fri"], Option.some(1_000)))

    assert.strictEqual(representation.controlState, "open")
  })

  it("is over once opened with an empty bill", () => {
    const representation = state(season([], ["Fri"], Option.some(1_000)))

    assert.strictEqual(representation.controlState, "over")
  })
})
