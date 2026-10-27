import { type DispatchRefused, layerLoopLocal } from "@mufw/core"
import { layerMount } from "@mufw/view-uhtml"
import { Effect, Layer } from "effect"
import { render } from "uhtml"
import type { Act } from "../../act.ts"
import type { CurrentPatron } from "../../domain/CurrentPatron.ts"
import type { PaymentGateway } from "../../domain/PaymentGateway.ts"
import { layerHistoryRows } from "../historyRows.ts"
import { Repertory, RepertoryPorts } from "./repertory.ts"
import "./style.css"
import { script } from "./script.ts"
import { makeSlots, shell, type Slots, stageView } from "./view.ts"

const refusedToLog = (refused: DispatchRefused) => Effect.logWarning(refused)

const islands = (slots: Slots) =>
  Layer.mergeAll(
    layerMount(RepertoryPorts, { root: slots.stage, view: stageView, render, onRefused: refusedToLog }),
    layerHistoryRows(RepertoryPorts, { root: slots.history, definition: Repertory, limit: 10 })
  )

/** One definition, one loop: the season and every night on its bill, composed with `compose`. */
export const repertoryAct: Act<PaymentGateway | CurrentPatron> = {
  script,
  layer: (root) =>
    Layer.unwrap(
      Effect.sync(() => {
        const slots = makeSlots()
        render(root, shell(slots))
        return islands(slots).pipe(Layer.provide(layerLoopLocal(Repertory, RepertoryPorts)))
      })
    )
}
