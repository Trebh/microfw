import type { View } from "@mufw/view-uhtml"
import { Option } from "effect"
import { type Hole, html } from "uhtml"
import type { Representation as StageRepresentation, SeatView } from "../../domain/BoxOffice.ts"
import type { Frame, Verdict } from "./reel.ts"
import type { Intent, Representation } from "./Rewind.ts"

type Dispatch = (intent: Intent) => void

const pad = (seq: number): string => String(seq).padStart(2, "0")

/** Redaction's cut by age: the newest frame is crisp, older ones degrade, the oldest fade. */
const cuts: ReadonlyArray<readonly [maxAge: number, cut: string]> = [
  [0, ""],
  [2, "past-10"],
  [5, "past-35"]
]

const cutOf = (age: number): string => cuts.find(([maxAge]) => age <= maxAge)?.[1] ?? "past-faded"

const spaced = (label: string): string => label.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()

const titles: Record<Frame["kind"], (frame: Frame) => string> = {
  init: () => "empty house",
  step: (frame) => spaced(frame.label),
  travel: (frame) =>
    Option.match(frame.travelledTo, { onNone: () => "jump back", onSome: (seq) => `back to ${pad(seq)}` })
}

/** A travel restarts the animations of its island: they alternate between two names, which CSS reads from this. */
const bleedOf = (travels: number): string => (travels === 0 ? "none" : travels % 2 === 0 ? "b" : "a")

const miniSeats = (seats: ReadonlyArray<SeatView>) =>
  html`<span class="seats" aria-hidden="true">${seats.map((seat) => html`<i class=${`seat seat--${seat.status}`}></i>`)}</span>`

const lampOf = (frame: Frame, isOnStage: boolean): string => {
  if (frame.age === 0) return "now"
  return isOnStage ? "on stage" : ""
}

const frameView = (rep: Representation, dispatch: Dispatch) => (frame: Frame) => {
  const isSelected = Option.exists(rep.selected, (seq) => seq === frame.seq)
  const isOnStage = Option.exists(rep.position, (seq) => seq === frame.seq)
  const isNewest = frame.age === 0
  const title = titles[frame.kind](frame)
  return html`<li
    class=${`frame frame--${frame.kind}`}
    data-seq=${frame.seq}
    data-selected=${isSelected}
    data-on-stage=${isOnStage}
    data-spot=${isNewest ? "frame-latest" : null}
    style=${`--age:${frame.age}`}
  >
    <button
      type="button"
      class="frame__body"
      aria-label=${`Jump to frame ${frame.seq}: ${title}, ${frame.held} held, ${frame.sold} sold`}
      aria-current=${isSelected ? "true" : null}
      onclick=${() => dispatch({ _tag: "TravelTo", seq: frame.seq })}
    >
      <span class="frame__seq marquee">${pad(frame.seq)}</span>
      <span class=${`frame__title ${cutOf(frame.age)}`}>${title}</span>
      ${miniSeats(frame.seats)}
      <span class="frame__label mono">${frame.label}</span>
      <span class="frame__lamp marquee">${lampOf(frame, isOnStage)}</span>
    </button>
  </li>`
}

const blankFrame = () =>
  html`<li class="frame frame--blank" data-spot="frame-latest">
    <span class="frame__title past-35">No frames yet. The first one appears as soon as the stage reports.</span>
  </li>`

const film = (rep: Representation, dispatch: Dispatch) =>
  html`<section class="film" data-spot="film" aria-labelledby="rewind-film">
    <h2 class="film__title marquee" id="rewind-film">The reel <span class="mono">oldest left, newest right</span></h2>
    <ol class="film__strip" data-follow=${rep.follow} tabindex="0" aria-label="Every record of the box office, oldest first">
      ${rep.frames.length === 0 ? [blankFrame()] : rep.frames.map(frameView(rep, dispatch))}
    </ol>
  </section>`

const waitNotes: Record<Representation["holdWait"], () => Hole> = {
  none: () => html`No seat is held, so nothing is waiting offstage.`,
  inflight: () =>
    html`<span class="offstage mono">AwaitExpiry</span> is waiting offstage for the earliest hold to run out.`,
  interrupted: () =>
    html`Going back (<span class="stage__cut mono">travelTo</span>) cancelled the wait for this hold to run out. Nothing runs on its own until the next proposal.`
}

const seatButton = (canHold: boolean, dispatch: Dispatch) => (seat: SeatView) =>
  html`<button
    type="button"
    class=${`seat seat--${seat.status}`}
    data-seat=${seat.id}
    ?disabled=${!(canHold && seat.status === "free")}
    aria-label=${`Seat ${seat.id}, ${seat.status}`}
    onclick=${() => dispatch({ _tag: "Hold", seat: seat.id })}
  >
    <span class="seat__id mono">${seat.id}</span>
    <span class="seat__by mono">${Option.getOrElse(seat.by, () => "")}</span>
  </button>`

const house = (stage: StageRepresentation, rep: Representation, dispatch: Dispatch) =>
  html`<div class="house" data-phase=${stage.controlState} data-wait=${rep.holdWait}>
    ${stage.seats.map(seatButton(stage.controlState === "selling", dispatch))}
  </div>`

const doorsButton = (stage: StageRepresentation, dispatch: Dispatch) =>
  stage.controlState === "dark"
    ? html`<button type="button" class="stage-button stage__doors" onclick=${() => dispatch({ _tag: "OpenDoors" })}>Open the doors</button>`
    : null

const stagePanel = (rep: Representation, dispatch: Dispatch) =>
  html`<section class="stage" data-spot="stage" data-bleed=${bleedOf(rep.travels)} aria-labelledby="rewind-stage">
    <header class="stage__head">
      <h2 class="stage__title marquee" id="rewind-stage">The stage <span class="mono">as it is now</span></h2>
      ${Option.match(rep.stage, {
        onNone: () => null,
        onSome: (stage) =>
          html`<p class="stage__counts marquee">
            <span>${stage.controlState}</span>
            <span>${stage.free} free</span>
            <span class="stage__held">${stage.held} held</span>
            <span class="stage__sold">${stage.sold} sold</span>
          </p>`
      })}
    </header>
    <div class="stage__floor">
      ${Option.match(rep.stage, {
        onNone: () => html`<p class="stage__empty past-35">The stage hasn't reported yet.</p>`,
        onSome: (stage) => house(stage, rep, dispatch)
      })}
    </div>
    <p class="stage__wait" data-spot="hold-wait" data-wait=${rep.holdWait}>${waitNotes[rep.holdWait]()}</p>
    ${Option.match(rep.stage, { onNone: () => null, onSome: (stage) => doorsButton(stage, dispatch) })}
    <p class="stage__note" aria-live="polite">${Option.getOrElse(rep.note, () => "")}</p>
  </section>`

const jumpsIn = (rep: Representation): number => rep.frames.filter((frame) => frame.kind === "travel").length

const neverForgets = (rep: Representation) =>
  html`<p class="never" data-spot="never-forgets" data-lit=${jumpsIn(rep) > 0} data-bleed=${bleedOf(rep.travels)}>
    <span class="never__line">Going back adds a new frame, so the history still shows that you went back.</span>
  </p>`

const untilText = (verdict: Verdict): string =>
  Option.match(verdict.until, {
    onNone: () => "to the newest frame",
    onSome: (seq) => `to the jump back at ${pad(seq)}`
  })

const replayedRow = (row: Verdict["replayed"][number]) =>
  html`<li data-equal=${row.equal}>
    <span>${pad(row.seq)}</span><span>${row.label}</span><span class="verdict__mark">${row.equal ? "=" : "≠"}</span>
  </li>`

const verdictBody = (verdict: Verdict) =>
  verdict.replayed.length === 0
    ? html`<p class="verdict__none">
      Nothing was proposed after frame ${pad(verdict.from)}, so there is nothing to replay. Pick an earlier frame.
    </p>`
    : html`<p class="verdict__result" data-agrees=${verdict.agrees}>
        <span class="verdict__seal marquee">${verdict.agrees ? "Match" : "Differs"}</span>
        <span class="verdict__sum">
          ${verdict.equalCount} of ${verdict.replayed.length} replayed
          ${verdict.replayed.length === 1 ? "model matches the recorded one" : "models match the recorded ones"},
          from frame ${pad(verdict.from)} ${untilText(verdict)}.
        </span>
      </p>
      <ol class="verdict__rows mono">${verdict.replayed.map(replayedRow)}</ol>`

const replayCard = (rep: Representation) =>
  html`<section class="verdict paper-card" data-spot="replay" style="--tilt: 0.5deg" aria-labelledby="rewind-replay">
    <header class="verdict__head">
      <h2 class="marquee" id="rewind-replay">Replay from this frame</h2>
      <p class="mono">replayFrom</p>
    </header>
    ${Option.match(rep.verdict, {
      onNone: () => html`<p class="verdict__none">Pick a frame to replay from.</p>`,
      onSome: verdictBody
    })}
  </section>`

const onScrub = (rep: Representation, dispatch: Dispatch) => (event: Event) => {
  const input = event.currentTarget
  if (!(input instanceof HTMLInputElement)) return
  const frame = rep.frames[input.valueAsNumber]
  if (frame !== undefined) dispatch({ _tag: "Select", seq: frame.seq })
}

const onRelease = (rep: Representation, dispatch: Dispatch) => (event: Event) => {
  const input = event.currentTarget
  if (!(input instanceof HTMLInputElement)) return
  const frame = rep.frames[input.valueAsNumber]
  if (frame !== undefined) dispatch({ _tag: "TravelTo", seq: frame.seq })
}

const selectedLine = (rep: Representation): string =>
  Option.match(rep.selected, {
    onNone: () => "no frame yet",
    onSome: (seq) => `frame ${pad(seq)} of ${pad(Math.max(0, rep.frames.length - 1))}`
  })

const transport = (rep: Representation, dispatch: Dispatch) =>
  html`<section class="transport" aria-label="Transport">
    <div class="transport__scrub" data-spot="scrubber">
      <label class="transport__label marquee" for="rewind-scrub">Jump to</label>
      <input
        id="rewind-scrub"
        class="transport__range"
        type="range"
        min="0"
        max=${Math.max(0, rep.frames.length - 1)}
        step="1"
        .value=${rep.selectedIndex}
        ?disabled=${rep.frames.length < 2}
        oninput=${onScrub(rep, dispatch)}
        onchange=${onRelease(rep, dispatch)}
      />
      <output class="transport__where mono" for="rewind-scrub">${selectedLine(rep)}</output>
    </div>
    <button
      type="button"
      class="stage-button"
      ?disabled=${Option.isNone(rep.doors)}
      onclick=${() => dispatch({ _tag: "ReturnToDoors" })}
    >Back to the doors</button>
    <button
      type="button"
      class="stage-button transport__export"
      data-spot="export"
      ?disabled=${rep.frames.length === 0}
      onclick=${() => dispatch({ _tag: "Export" })}
    >Take the recording home <span class="mono">box-office-history.json</span></button>
  </section>`

const counter = (label: string, value: number) =>
  html`<div class="counter"><dt class="mono">${label}</dt><dd class="marquee">${pad(value)}</dd></div>`

/** Pure: the reel as it is, with `data-bleed` and `data-follow` carrying what CSS and the layer's scroll react to. */
export const view: View<Representation, Intent> = (rep, dispatch) =>
  html`<div class="rewind" data-state=${rep.controlState}>
    <header class="rewind__head">
      <h1 class="rewind__title">The reel of tonight</h1>
      <dl class="rewind__counters">
        ${counter("frames", rep.frames.length)}
        ${counter("jumps back", jumpsIn(rep))}
      </dl>
    </header>
    ${stagePanel(rep, dispatch)}
    <div class="rewind__side">
      ${neverForgets(rep)}
      ${replayCard(rep)}
    </div>
    ${transport(rep, dispatch)}
    ${film(rep, dispatch)}
  </div>`
