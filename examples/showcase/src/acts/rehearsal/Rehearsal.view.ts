import type { View } from "@mufw/view-uhtml"
import { Option } from "effect"
import { type Hole, html } from "uhtml"
import type { Failure, Intent, Line, Representation } from "./Rehearsal.ts"
import { type CallSheetLine, callSheet, type StepTag } from "./sheet.ts"
import { SABOTAGED_TARGET } from "./understudy.ts"

const stepTag = (tag: StepTag) =>
  html`<li class="rehearsal__tag mono">${tag.name}${tag.times > 1 ? html`<span class="rehearsal__times"> ×${tag.times}</span>` : null}</li>`

const stepLabel = (entry: CallSheetLine, failure: Failure): string => {
  if (failure.stepIndex < 0) return "before the first step"
  const name = entry.stepNames[failure.stepIndex] ?? "?"
  return `step ${failure.stepIndex + 1} of ${entry.stepNames.length}, ${name}`
}

/** The stage manager's note: what `PathFailure` carries, pinned to the line it failed. */
const stageManagersNote = (entry: CallSheetLine, failure: Failure) =>
  html`<aside class="rehearsal__note paper-card" role="note" style="--tilt: 1.4deg">
    <p class="rehearsal__note-head marquee">Stage manager's note</p>
    <dl class="rehearsal__note-facts mono">
      <div><dt>target</dt><dd>${failure.target}</dd></div>
      <div><dt>step</dt><dd>${stepLabel(entry, failure)}</dd></div>
      <div><dt>expected</dt><dd>${failure.expected}</dd></div>
      <div><dt>actual</dt><dd>${failure.actual}</dd></div>
    </dl>
    <p class="rehearsal__note-message">${failure.message}</p>
  </aside>`

const STATUS_WORDS: Record<Line["status"], string> = {
  pending: "waiting",
  running: "running",
  passed: "passed",
  failed: "failed"
}

const pathLine = (entry: CallSheetLine, line: Line) =>
  html`<li
    class="rehearsal__path"
    data-status=${line.status}
    data-spot=${entry.target === SABOTAGED_TARGET ? "failure" : null}
  >
    <span class="rehearsal__mark" aria-hidden="true"></span>
    <div class="rehearsal__body">
      <p class="rehearsal__reach" title=${entry.name}>
        <span class="rehearsal__ordinal mono">${entry.index + 1}</span>
        <span class="rehearsal__reach-text">${entry.reach}</span>
        <span class="rehearsal__status mono">${STATUS_WORDS[line.status]}</span>
      </p>
      <ol class="rehearsal__steps">${entry.tags.map(stepTag)}</ol>
    </div>
    ${Option.getOrNull(Option.map(line.failure, (failure) => stageManagersNote(entry, failure)))}
  </li>`

const pathLines = (representation: Representation): ReadonlyArray<Hole> =>
  representation.lines.flatMap((line) =>
    Option.toArray(Option.map(Option.fromNullishOr(callSheet[line.index]), (entry) => pathLine(entry, line)))
  )

const totalReading = (representation: Representation): string => {
  const base = `${representation.passed} of ${representation.total} passed`
  return representation.failed > 0 ? `${base}, ${representation.failed} failed` : base
}

const rehearseLabel = (representation: Representation): string => {
  if (representation.controlState === "rehearsing") return "Rehearsing"
  return representation.controlState === "idle" ? "Rehearse" : "Rehearse again"
}

/** The call sheet, the two controls, and the total. Both controls call a rehearsal; the toggle picks the understudy. */
export const sheetView: View<Representation, Intent> = (representation, dispatch) => {
  const sabotaged = representation.understudy === "sabotaged"
  return html`<header class="rehearsal__sheet-head">
      <h2 class="rehearsal__heading marquee" id="rehearsal-sheet">Call sheet <span class="past-35">the shortest way to each state</span></h2>
    </header>
    <ol
      class="rehearsal__paths"
      data-spot="call-sheet"
      data-state=${representation.controlState}
      data-understudy=${representation.understudy}
    >${pathLines(representation)}</ol>
    <footer class="rehearsal__controls" data-spot="controls">
      <button
        type="button"
        class="stage-button rehearsal__rehearse"
        ?disabled=${representation.controlState === "rehearsing"}
        onclick=${() => dispatch({ _tag: "Rehearse", understudy: representation.understudy })}
      >${rehearseLabel(representation)}</button>
      <button
        type="button"
        class="stage-button rehearsal__sabotage"
        data-spot="sabotage"
        aria-pressed=${String(sabotaged)}
        onclick=${() => dispatch({ _tag: "Rehearse", understudy: sabotaged ? "honest" : "sabotaged" })}
      ><span class="lamp" aria-hidden="true"></span>Sabotage</button>
      <p class="rehearsal__total marquee" data-spot="total" data-state=${representation.controlState} role="status">
        ${totalReading(representation)}
      </p>
    </footer>`
}
