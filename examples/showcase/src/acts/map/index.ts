import { type HistoryPort, layerForward, layerLoopLocal, makePorts, type ModelPort } from "@mufw/core"
import { layerMount } from "@mufw/view-uhtml"
import { Effect, Layer } from "effect"
import { render } from "uhtml"
import type { Act } from "../../act.ts"
import { Deck, DeckPorts } from "../../deck/Deck.ts"
import type { BoxOffice } from "../../domain/BoxOffice.ts"
import { type Chart, surveyStage } from "./Chart.ts"
import { forwardWalk, layerFollowStage } from "./Follow.ts"
import "./style.css"
import { script } from "./script.ts"
import { makeSurvey } from "./Survey.ts"
import { makeMapView } from "./View.ts"

const island = (root: HTMLElement, chart: Chart) => {
  const survey = makeSurvey(chart.ways)
  const ports = makePorts(survey)
  return Layer.mergeAll(
    layerMount(ports, {
      root,
      view: makeMapView(chart),
      render,
      onRefused: (refused) => Effect.logWarning(refused)
    }),
    layerForward(DeckPorts, ports, forwardWalk),
    layerFollowStage(chart, ports)
  ).pipe(Layer.provide(layerLoopLocal(survey, ports)))
}

/**
 * The map of the Box Office, explored once and purely. A small loop of its own walks a light over
 * the shortest paths and counts what the shared stage's history crossed; the deck cues the walk.
 */
export const mapAct: Act<ModelPort<typeof BoxOffice> | HistoryPort<typeof BoxOffice> | ModelPort<typeof Deck>> = {
  script,
  layer: (root) => Layer.unwrap(Effect.sync(() => island(root, surveyStage())))
}
