import { type Forward, layerForward, layerLoopLocal, type ModelPort } from "@mufw/core"
import { layerMount, layerMountReadOnly } from "@mufw/view-uhtml"
import { Effect, Layer, Option } from "effect"
import { render } from "uhtml"
import type { Act } from "../../act.ts"
import { type Deck, DeckPorts } from "../../deck/Deck.ts"
import { type Intent, Rehearsal, RehearsalPorts } from "./Rehearsal.ts"
import "./style.css"
import { script } from "./script.ts"
import { honestPorts, layerUnderstudies, sabotagedPorts } from "./understudy.ts"
import { houseView, sheetView, shell } from "./views.ts"

const dismiss: Intent = { _tag: "Dismiss" }
const rehearseHonest: Intent = { _tag: "Rehearse", understudy: "honest" }
const settleHonest: Intent = { _tag: "Settle", understudy: "honest" }
const rehearseSabotaged: Intent = { _tag: "Rehearse", understudy: "sabotaged" }
const settleSabotaged: Intent = { _tag: "Settle", understudy: "sabotaged" }

/**
 * What the stage manager asks of the rehearsal when each cue comes up, in the script's order.
 * Coming back to a cue sets the room as that cue left it: `Settle` leaves a rehearsal that is
 * already on the right understudy alone, `Rehearse` starts one.
 */
const onCue: ReadonlyArray<Intent> = [
  dismiss,
  dismiss,
  dismiss,
  rehearseHonest,
  settleHonest,
  settleHonest,
  rehearseSabotaged,
  settleSabotaged,
  settleSabotaged
]

const enteredCue = (previous: Option.Option<{ readonly actId: string; readonly cue: number }>, cue: number) =>
  Option.match(previous, {
    onNone: () => true,
    onSome: (before) => before.actId !== script.id || before.cue !== cue
  })

/** An intent only when the deck has just moved to a cue of this act. */
const cueForward: Forward<typeof Deck, typeof Rehearsal> = (previous, current) => {
  if (current.actId !== script.id || !enteredCue(previous, current.cue)) return Option.none()
  return Option.fromNullishOr(onCue[current.cue])
}

const located = (root: HTMLElement, selector: string): Effect.Effect<HTMLElement> =>
  Option.match(Option.fromNullishOr(root.querySelector<HTMLElement>(selector)), {
    onNone: () => Effect.die(`#act-${script.id} has no ${selector}`),
    onSome: Effect.succeed
  })

/** The rehearsal loop over both understudies, which the mounts and the action read through the same context. */
const rehearsalLoop = layerLoopLocal(Rehearsal, RehearsalPorts).pipe(Layer.provideMerge(layerUnderstudies))

const island = (parts: {
  readonly sheet: HTMLElement
  readonly honestHouse: HTMLElement
  readonly sabotagedHouse: HTMLElement
}) =>
  Layer.mergeAll(
    layerMount(RehearsalPorts, {
      root: parts.sheet,
      view: sheetView,
      render,
      onRefused: (refused) => Effect.logWarning(refused)
    }),
    layerMountReadOnly(honestPorts, { root: parts.honestHouse, view: houseView, render }),
    layerMountReadOnly(sabotagedPorts, { root: parts.sabotagedHouse, view: houseView, render }),
    layerForward(DeckPorts, RehearsalPorts, cueForward)
  ).pipe(Layer.provide(rehearsalLoop))

/**
 * Model-based testing, live: the call sheet is the explored graph's shortest paths, the rehearsal is
 * a loop of its own that runs them with `@mufw/test` on an understudy Box Office, and a sabotaged
 * understudy makes one of them fail with a real `PathFailure`.
 */
export const rehearsalAct: Act<ModelPort<typeof Deck>> = {
  script,
  layer: (root) =>
    Layer.unwrap(
      Effect.gen(function*() {
        yield* Effect.sync(() => render(root, shell()))
        const sheet = yield* located(root, ".rehearsal__sheet")
        const honestHouse = yield* located(root, `.rehearsal__house[data-house="honest"]`)
        const sabotagedHouse = yield* located(root, `.rehearsal__house[data-house="sabotaged"]`)
        return island({ sheet, honestHouse, sabotagedHouse })
      })
    )
}
