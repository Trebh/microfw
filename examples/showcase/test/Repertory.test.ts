import { assert, describe, it } from "@effect/vitest"
import { applyProposal } from "@mufw/core"
import { Option } from "effect"
import { Repertory } from "../src/acts/repertory/repertory.ts"
import type { Model as SeasonModel } from "../src/acts/repertory/Season.ts"
import { initial, type Model as BoxModel } from "../src/domain/BoxOffice.ts"

const sellingSince = (now: number): BoxModel => ({ ...initial, phase: "selling", now })

const at = (season: SeasonModel, nights: ReadonlyArray<readonly [string, BoxModel]>) => ({
  parent: season,
  parts: { Nights: nights.map(([key, model]) => ({ key, model })) }
})

describe("Repertory", () => {
  it("SeasonOpened opens the doors of every night on the bill in the same step", () => {
    const model = at({ programme: ["Fri", "Sat"], played: [], openedAt: Option.none() }, [["Fri", initial], ["Sat", initial]])

    const next = applyProposal(Repertory, model, { _tag: "SeasonOpened", at: 1_000 })

    assert.deepStrictEqual(
      next,
      at({ programme: ["Fri", "Sat"], played: [], openedAt: Option.some(1_000) }, [
        ["Fri", sellingSince(1_000)],
        ["Sat", sellingSince(1_000)]
      ])
    )
  })

  it("a night's CurtainRaised drops it from the collection and lists it as played", () => {
    const season = { programme: ["Fri", "Sat"], played: [], openedAt: Option.some(1_000) }
    const model = at(season, [["Fri", sellingSince(1_000)], ["Sat", sellingSince(1_000)]])

    const next = applyProposal(Repertory, model, {
      _tag: "Nights",
      key: "Fri",
      proposal: { _tag: "CurtainRaised", at: 2_000 }
    })

    assert.deepStrictEqual(
      next,
      at({ programme: ["Sat"], played: ["Fri"], openedAt: Option.some(1_000) }, [["Sat", sellingSince(1_000)]])
    )
  })

  it("NightProgrammed creates the night from the box office's initial model", () => {
    const model = at({ programme: [], played: [], openedAt: Option.none() }, [])

    const next = applyProposal(Repertory, model, { _tag: "NightProgrammed", night: "Fri" })

    assert.deepStrictEqual(next, at({ programme: ["Fri"], played: [], openedAt: Option.none() }, [["Fri", initial]]))
  })
})
