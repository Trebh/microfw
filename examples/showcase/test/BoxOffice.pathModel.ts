import { assert } from "@effect/vitest"
import { createTestModel, type TestModelOptions } from "@mufw/test"
import { BoxOffice, BoxOfficePorts } from "../src/domain/BoxOffice.ts"
import { exploreBoxOffice, serializeBoxOffice } from "../src/domain/BoxOffice.explore.ts"

/** The box office's test model: exploration alphabet plus one assertion per control state. */
export const boxOfficeTestModel: TestModelOptions<typeof BoxOffice> = {
  explore: exploreBoxOffice,
  serialize: serializeBoxOffice,
  states: {
    dark: (representation) => {
      assert.strictEqual(representation.sold + representation.held, 0)
      assert.strictEqual(representation.free, 18)
    },
    selling: (representation) => {
      assert.isAbove(representation.free, 0)
    },
    full: (representation) => {
      assert.strictEqual(representation.free, 0)
      assert.strictEqual(representation.seats.filter((seat) => seat.status === "free").length, 0)
    },
    curtain: (representation) => {
      assert.strictEqual(representation.held, 0)
    }
  }
}

export const boxOfficeModel = createTestModel(BoxOffice, BoxOfficePorts, boxOfficeTestModel)
