import type { ModelPort } from "@mufw/core"
import { Effect, Layer } from "effect"
import { render } from "uhtml"
import type { Act } from "../../act.ts"
import type { Deck } from "../../deck/Deck.ts"
import "./style.css"
import { island, type Mounts } from "./island.ts"
import { acrossTown, inTheHouse, inTheWings } from "./placements.ts"
import { tour } from "./scaffold.ts"
import { script } from "./script.ts"
import { house, type Stage, town, wings } from "./stages.ts"

const element = (tag: "div" | "span", className: string): HTMLElement => {
  const created = document.createElement(tag)
  created.className = className
  return created
}

/** The lamp reads `waking` until its stage says otherwise, so a worker that is slow to start is seen to be. */
const mountsOfOneStage = (): Mounts => {
  const lamp = element("span", "tour__lamp mono")
  lamp.dataset.state = "connecting"
  lamp.textContent = "waking"
  return { seats: element("div", "tour__seats"), meter: element("div", "tour__meter-mount"), lamp }
}

/**
 * The same play on three stages. Each stage is its own company with its own loop: in this page, in
 * a web worker, behind an RPC client. Only the layers that provide a stage's ports differ; the seat
 * map and the stopwatch are the same functions over all three.
 */
export const tourAct: Act<ModelPort<typeof Deck>> = {
  script,
  layer: (root) =>
    Layer.unwrap(
      Effect.sync(() => {
        const mounts: Readonly<Record<Stage["id"], Mounts>> = {
          house: mountsOfOneStage(),
          wings: mountsOfOneStage(),
          town: mountsOfOneStage()
        }
        render(root, tour(mounts))
        return Layer.mergeAll(
          island(house, inTheHouse, mounts.house),
          island(wings, inTheWings, mounts.wings),
          island(town, acrossTown, mounts.town)
        )
      })
    )
}
