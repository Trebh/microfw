import type { View } from "@mufw/view-uhtml"
import { Option } from "effect"
import { type Hole, html } from "uhtml"
import type { ActScript, Cue } from "../act.ts"
import type { Intent, Representation } from "./Deck.ts"

type Dispatch = (intent: Intent) => void

export interface Segment {
  readonly direction: boolean
  readonly text: string
}

/** A line split into spoken text and `[stage directions]`, which keep their brackets. */
export const segments = (line: string): ReadonlyArray<Segment> =>
  line
    .split(/(\[[^\]]*\])/)
    .filter((text) => text !== "")
    .map((text) => ({ direction: text.startsWith("["), text }))

const cueAt = (scripts: ReadonlyArray<ActScript>, actIndex: number, cue: number): Option.Option<Cue> =>
  Option.fromNullishOr(scripts[actIndex]?.cues[cue])

/** The cue before the current one, in running order: at an act's first cue, the previous act's last. */
export const previousCue = (
  scripts: ReadonlyArray<ActScript>,
  representation: Pick<Representation, "actIndex" | "cue">
): Option.Option<Cue> => {
  const { actIndex, cue } = representation
  if (cue > 0) return cueAt(scripts, actIndex, cue - 1)
  const previousAct = scripts[actIndex - 1]
  if (previousAct === undefined) return Option.none()
  return cueAt(scripts, actIndex - 1, previousAct.cues.length - 1)
}

/** 0 or 1, alternating with every cue in running order, so a stylesheet can restart an animation by swapping its name. */
export const flipOf = (
  scripts: ReadonlyArray<ActScript>,
  representation: Pick<Representation, "actIndex" | "cue">
): 0 | 1 => {
  const before = scripts.slice(0, representation.actIndex).reduce((total, script) => total + script.cues.length, 0)
  return (before + representation.cue) % 2 === 0 ? 0 : 1
}

/** uhtml v4 diffs an array of holes as nodes, so spoken text is a hole too, never a bare string. */
const renderSegments = (line: string): ReadonlyArray<Hole> =>
  segments(line).map((segment) =>
    segment.direction ? html`<em class="direction">${segment.text}</em>` : html`<span>${segment.text}</span>`
  )

const playbillAct = (script: ActScript, index: number, representation: Representation, dispatch: Dispatch) => {
  const isCurrent = script.id === representation.actId
  return html`<li>
    <button
      type="button"
      class="playbill__act"
      aria-current=${isCurrent ? "step" : null}
      onclick=${() => dispatch({ _tag: "GoTo", actId: script.id, cue: 0 })}
    >
      <span class="playbill__key mono">${index + 1}</span>
      <span class="playbill__numeral marquee">${script.numeral}</span>
      <span class="playbill__title">${script.title}</span>
    </button>
  </li>`
}

const playbill = (scripts: ReadonlyArray<ActScript>, representation: Representation, dispatch: Dispatch) =>
  html`<nav class="playbill" aria-label="The programme">
    <p class="playbill__house marquee">µFW</p>
    <ol class="playbill__acts">
      ${scripts.map((script, index) => playbillAct(script, index, representation, dispatch))}
    </ol>
  </nav>`

/** Lines up to this long are set at full size; the surtitle strip holds three lines of it. */
const FULL_SIZE_LIMIT = 140
const MEDIUM_SIZE_LIMIT = 220

/** The size class of a surtitle: longer lines are set smaller so they still fit the strip's three lines. */
export const surtitleSize = (line: string): "l" | "m" | "s" => {
  if (line.length <= FULL_SIZE_LIMIT) return "l"
  return line.length <= MEDIUM_SIZE_LIMIT ? "m" : "s"
}

const surtitles = (scripts: ReadonlyArray<ActScript>, representation: Representation) => {
  const script = scripts[representation.actIndex]
  const flip = flipOf(scripts, representation)
  const current = cueAt(scripts, representation.actIndex, representation.cue).pipe(
    Option.map((cue) => cue.line),
    Option.getOrElse(() => "")
  )
  const past = previousCue(scripts, representation).pipe(
    Option.map((cue) => cue.line),
    Option.getOrElse(() => "")
  )
  return html`<section class="surtitles" aria-label="Surtitles">
    <p class="surtitle surtitle--past past-70" data-flip=${String(flip)} aria-hidden="true">${renderSegments(past)}</p>
    <p class="surtitle surtitle--now" data-flip=${String(flip)} data-size=${surtitleSize(current)} aria-live="polite">${renderSegments(current)}</p>
    <p class="surtitles__where marquee">${script?.numeral ?? ""} ${script?.title ?? ""}</p>
  </section>`
}


const controls = (representation: Representation, dispatch: Dispatch) => {
  const percent = Math.round(representation.progress * 100)
  return html`<footer class="controls">
    <div class="controls__buttons">
      <button
        type="button"
        class="stage-button"
        ?disabled=${representation.actIndex === 0 && representation.cue === 0}
        onclick=${() => dispatch({ _tag: "Previous" })}
      ><kbd>←</kbd> Back</button>
      <button
        type="button"
        class="stage-button"
        ?disabled=${representation.controlState === "ended"}
        onclick=${() => dispatch({ _tag: "Next" })}
      >Next <kbd>→</kbd></button>
      <button
        type="button"
        class="stage-button"
        aria-pressed=${String(representation.autoplay)}
        onclick=${() => dispatch({ _tag: "ToggleAutoplay" })}
      ><span class="lamp" aria-hidden="true"></span>Autoplay <kbd>A</kbd></button>
    </div>
    <div
      class="fuse"
      role="progressbar"
      aria-label="Progress through the show"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${String(percent)}
      style=${`--progress:${representation.progress}`}
    ></div>
    <p class="controls__count mono">cue ${representation.cue + 1}/${representation.cueCount} · act ${representation.actIndex + 1}/${representation.actCount}</p>
  </footer>`
}

/** The page chrome: the playbill ribbon, the surtitles above the stage, and the controls with the fuse. */
export const makeDeckView = (scripts: ReadonlyArray<ActScript>): View<Representation, Intent> =>
(representation, dispatch) =>
  html`${playbill(scripts, representation, dispatch)}${surtitles(scripts, representation)}${controls(representation, dispatch)}`
