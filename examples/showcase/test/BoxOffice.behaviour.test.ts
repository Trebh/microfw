import { renderBehaviour } from "@mufw/test"
import { expect, it } from "vitest"
import { BoxOffice } from "../src/domain/BoxOffice.ts"
import { boxOfficeModel } from "./BoxOffice.pathModel.ts"

it("the committed behaviour card matches the definition", async () => {
  const card = renderBehaviour(BoxOffice, boxOfficeModel.graph)

  await expect(card).toMatchFileSnapshot("../src/domain/BoxOffice.behaviour.md")
})
