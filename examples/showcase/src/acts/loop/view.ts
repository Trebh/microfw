import type { View } from "@mufw/view-uhtml"
import { Option } from "effect"
import { type Hole, html } from "uhtml"
import type { Intent as StageIntent, Representation as StageRepresentation, SeatView } from "../../domain/BoxOffice.ts"
import type { Intent, Representation } from "./board.ts"
import { firedStations, proposalText, type Scene, STATIONS, type StationId } from "./scene.ts"
import { acceptorFor, firstAcceptor, type Quote, reactor, SOURCE_FILE, type Token, tokenize } from "./source.ts"

type Dispatch = (intent: Intent) => void

const ROWS = ["A", "B", "C"] as const

/** The superstitious seat: the gateway declines it, and the house marks it. */
const SUPERSTITIOUS = "C6"

const controlStateOf = (representation: Representation): StageRepresentation["controlState"] =>
  Option.match(representation.stage, { onNone: () => "dark" as const, onSome: (stage) => stage.controlState })

/** What a click on this seat asks for: hold it while free, pay for it while held, nothing otherwise. */
const seatIntent = (seat: SeatView, open: boolean, charging: boolean): Option.Option<StageIntent> => {
  if (!open || charging) return Option.none()
  if (seat.status === "free") return Option.some({ _tag: "Hold", seat: seat.id } as const)
  if (seat.status === "held") return Option.some({ _tag: "Pay", seat: seat.id } as const)
  return Option.none()
}

const seatHint = (seat: SeatView, charging: boolean): string => {
  if (charging) return `${seat.id}: paying, the gateway is thinking`
  if (seat.status === "free") return `${seat.id}: free. Click to hold it`
  if (seat.status === "held") return `${seat.id}: held. Click to pay`
  return `${seat.id}: sold`
}

const evilEye = () =>
  html`<svg class="seat__mark" viewBox="0 0 16 10" aria-hidden="true">
    <path d="M1 5 Q8 -1.5 15 5 Q8 11.5 1 5Z" fill="none" stroke="currentColor" stroke-width="1.2" />
    <circle cx="8" cy="5" r="1.9" fill="currentColor" />
  </svg>`

const ringOf = (seat: SeatView): Hole | null =>
  Option.match(seat.heldUntil, {
    onNone: () => null,
    onSome: (until) => html`<span class="seat__ring" data-hold-until=${String(until)}></span>`
  })

const seatCell = (seat: SeatView, representation: Representation, dispatch: Dispatch) => {
  const charging = representation.charging.some((charge) => charge.seat === seat.id)
  const stageState = controlStateOf(representation)
  const open = stageState === "selling" || stageState === "full"
  const intent = seatIntent(seat, open, charging)
  const column = Number(seat.id.slice(1)) - 1
  const chosen = Option.getOrNull(intent)
  const click = () => {
    if (chosen !== null) dispatch({ _tag: "Ask", intent: chosen })
  }
  return html`<li class="loop__cell" style=${`--k:${column}`}>
    <button
      type="button"
      class="seat"
      data-seat=${seat.id}
      data-status=${seat.status}
      data-charging=${String(charging)}
      data-spot=${`seat-${seat.id}`}
      title=${seatHint(seat, charging)}
      aria-label=${seatHint(seat, charging)}
      ?disabled=${Option.isNone(intent)}
      onclick=${click}
    >
      ${ringOf(seat)}
      <span class="seat__chair"></span>
      <span class="seat__id mono">${seat.id}</span>
      ${seat.id === SUPERSTITIOUS ? evilEye() : null}
    </button>
  </li>`
}

const seatRow = (row: string, seats: ReadonlyArray<SeatView>, representation: Representation, dispatch: Dispatch) =>
  html`<li class="loop__row">
    <span class="loop__row-label marquee" aria-hidden="true">${row}</span>
    <ol class="loop__row-seats">
      ${seats.filter((seat) => seat.id.startsWith(row)).map((seat) => seatCell(seat, representation, dispatch))}
    </ol>
  </li>`

const doorsTicket = (representation: Representation, dispatch: Dispatch) =>
  controlStateOf(representation) === "dark"
    ? html`<div class="loop__doors">
      <button type="button" class="stage-button" onclick=${() => dispatch({ _tag: "Ask", intent: { _tag: "OpenDoors" } })}>
        Open the doors
      </button>
    </div>`
    : null

const count = (label: string, value: number, tone: string) =>
  html`<div class="loop__count" data-tone=${tone}>
    <dt class="marquee">${label}</dt>
    <dd class="marquee">${value}</dd>
  </div>`

const stageManagersNote = (stage: Option.Option<StageRepresentation>) =>
  Option.match(Option.flatMap(stage, (representation) => representation.lastRefusal), {
    onNone: () => null,
    onSome: (refusal) =>
      html`<aside class="loop__note paper-card" role="status">
        <p class="loop__note-from marquee">The stage manager's note</p>
        <p class="loop__note-text">${refusal}</p>
      </aside>`
  })

const doorsFootnote = (representation: Representation) =>
  representation.doors === "opened"
    ? html`<p class="loop__footnote mono">[the stage manager opened the doors on cue]</p>`
    : null

const house = (representation: Representation, dispatch: Dispatch) => {
  const stage = representation.stage
  const seats = Option.match(stage, { onNone: () => [], onSome: (found) => found.seats })
  const { free, held, sold } = Option.match(stage, {
    onNone: () => ({ free: 0, held: 0, sold: 0 }),
    onSome: (found) => found
  })
  return html`<section class="loop__house" data-spot="house" data-state=${controlStateOf(representation)} aria-label="The house">
    <header class="loop__heading">
      <p class="loop__kicker marquee">The house</p>
      <p class="loop__state mono">${controlStateOf(representation)}</p>
    </header>
    <div class="loop__apron" aria-hidden="true"><span class="marquee">the stage</span></div>
    <div class="loop__seats" data-spot="seats">
      <ol class="loop__rows">${ROWS.map((row) => seatRow(row, seats, representation, dispatch))}</ol>
      ${doorsTicket(representation, dispatch)}
    </div>
    <dl class="loop__counts">
      ${count("free", free, "free")}${count("held", held, "held")}${count("sold", sold, "sold")}
    </dl>
    <div class="loop__notes">${stageManagersNote(stage)}${doorsFootnote(representation)}</div>
  </section>`
}

interface StationDef {
  readonly id: StationId
  readonly name: string
  readonly code: string
}

const stationDefs: Readonly<Record<StationId, StationDef>> = {
  intent: { id: "intent", name: "Intent", code: "intent" },
  action: { id: "action", name: "Action", code: "actions" },
  proposal: { id: "proposal", name: "Proposal", code: "proposal" },
  acceptors: { id: "acceptors", name: "Acceptors", code: "acceptors" },
  reactors: { id: "reactors", name: "Reactors", code: "reactors" },
  state: { id: "state", name: "State", code: "state" },
  nap: { id: "nap", name: "NAP", code: "nap" }
}

const seatsText = (seats: ReadonlyArray<string>) => seats.join(", ")

const actionNote = (representation: Representation, scene: Option.Option<Scene>): string => {
  if (representation.charging.length > 0) {
    return `offstage: charging… ${seatsText(representation.charging.map((charge) => charge.seat))}`
  }
  return Option.isSome(scene) ? "came back with a proposal" : "waiting in the wings"
}

const fieldsText = (scene: Scene): string => {
  if (scene.changes.length === 0) return "changed nothing"
  return scene.changes.length === 1 ? "1 field changed" : `${scene.changes.length} fields changed`
}

const stationNote = (id: StationId, representation: Representation): string => {
  const scene = representation.scene
  if (id === "action") return actionNote(representation, scene)
  return Option.match(scene, {
    onNone: () => (id === "intent" ? "ask for a seat" : "—"),
    onSome: (current) => {
      const notes: Readonly<Record<Exclude<StationId, "action">, string>> = {
        intent: current.automatic ? `${current.intent} · by NAP` : current.intent,
        proposal: current.proposal._tag,
        acceptors: fieldsText(current),
        reactors: current.freed.length > 0 ? `freed ${seatsText(current.freed)}` : "nothing to tidy",
        state: current.controlState,
        nap: Option.match(current.whisper, { onNone: () => "silent", onSome: (intent) => intent._tag })
      }
      return notes[id]
    }
  })
}

const station = (id: StationId, index: number, representation: Representation) => {
  const def = stationDefs[id]
  const fired = Option.match(representation.scene, { onNone: () => false, onSome: (scene) => firedStations(scene)[index] === true })
  const offstage = id === "action" && representation.charging.length > 0
  return html`<li
    class="station"
    data-station=${id}
    data-spot=${`st-${id}`}
    data-fired=${String(fired)}
    data-offstage=${String(offstage)}
  >
    <span class="station__no mono">${index + 1}</span>
    <span class="station__name marquee">${def.name}</span>
    <span class="station__code mono">${def.code}</span>
    <span class="station__note">${stationNote(id, representation)}</span>
  </li>`
}

/** Redaction degrades with age: the newest earlier scene is nearly fresh, the oldest long gone. */
const pastCuts = ["past-10", "past-35", "past-70", "past-100"]

const earlierScenes = (representation: Representation) => {
  const earlier = representation.recent.slice(0, -1).slice(-pastCuts.length)
  return html`<ol class="loop__recent" aria-label="Earlier scenes">
    ${earlier.map((scene, index) => {
      const age = earlier.length - 1 - index
      return html`<li class=${pastCuts[age] ?? "past-100"}>${scene.tag}</li>`
    })}
  </ol>`
}

const chip = (field: string, change: string) =>
  html`<li class="chip"><b class="chip__field mono">${field}</b><span class="chip__change">${change}</span></li>`

const proposalItem = (scene: Option.Option<Scene>) =>
  html`<div class="ledger__item ledger__item--proposal" data-spot="ledger-proposal">
    <dt class="marquee">Proposal</dt>
    <dd class="mono">${Option.match(scene, { onNone: () => "nothing has been proposed yet", onSome: (current) => proposalText(current.proposal) })}</dd>
  </div>`

const acceptorsItem = (scene: Option.Option<Scene>) =>
  html`<div class="ledger__item">
    <dt class="marquee">Acceptors changed</dt>
    <dd>${
    Option.match(scene, {
      onNone: () => html`<p class="ledger__quiet">no scene yet</p>`,
      onSome: (current) =>
        current.changes.length === 0
          ? html`<p class="ledger__quiet">the model kept every field</p>`
          : html`<ul class="chips">${current.changes.map((change) => chip(change.field, change.change))}</ul>
            <p class="ledger__by mono">by ${current.movers.join(", ")}</p>`
    })
  }</dd>
  </div>`

const reactorsItem = (scene: Option.Option<Scene>) => {
  const freed = Option.match(scene, { onNone: () => [], onSome: (current) => current.freed })
  return html`<div class="ledger__item" data-fired=${String(freed.length > 0)}>
    <dt class="marquee">Reactors</dt>
    <dd>${
    freed.length > 0
      ? html`<p class="ledger__freed">freed <b class="mono">${seatsText(freed)}</b>: its hold had run out</p>`
      : html`<p class="ledger__quiet">${Option.isSome(scene) ? "the stage was already tidy" : "no scene yet"}</p>`
  }</dd>
  </div>`
}

const stateItem = (scene: Option.Option<Scene>) =>
  html`<div class="ledger__item">
    <dt class="marquee">State</dt>
    <dd>${
    Option.match(scene, {
      onNone: () => html`<p class="ledger__quiet">no scene yet</p>`,
      onSome: (current) =>
        html`<p><b class="mono">${current.controlState}</b></p>
          <p class="ledger__quiet mono">${current.free} free · ${current.held} held · ${current.sold} sold</p>`
    })
  }</dd>
  </div>`

const whisperLine = (scene: Scene): string =>
  Option.match(scene.whisper, {
    onNone: () => (scene.controlState === "curtain" ? "The curtain is up. Nothing more to say." : "Nothing to wait for. I keep quiet."),
    onSome: (intent) =>
      intent._tag === "RaiseCurtain"
        ? "Every seat is sold: raise the curtain."
        : "Wait for the earliest hold to run out, then tick."
  })

const napItem = (scene: Option.Option<Scene>) =>
  html`<div class="ledger__item ledger__item--prompter" data-spot="ledger-nap">
    <dt class="marquee">NAP whispers</dt>
    <dd>${
    Option.match(scene, {
      onNone: () => html`<p class="ledger__quiet">The prompter has not seen a scene yet.</p>`,
      onSome: (current) =>
        html`<p class="prompter">${whisperLine(current)}</p>
          <p class="ledger__by mono">${Option.match(current.whisper, { onNone: () => "none", onSome: (intent) => intent._tag })}</p>`
    })
  }</dd>
  </div>`

const codeToken = (token: Token, tag: string) => {
  const isTag = token.kind === "string" && token.text === `"${tag}"`
  return html`<span class=${isTag ? "tk-tag" : `tk-${token.kind}`}>${token.text}</span>`
}

const codeBlock = (quote: Quote, tag: string) =>
  html`<pre class="code__block"><code>${quote.code.split("\n").map((line) => html`<span class="code__line">${tokenize(line).map((token) => codeToken(token, tag))}</span>`)}</code></pre>`

const codeCard = (scene: Option.Option<Scene>) => {
  const tag = Option.match(scene, { onNone: () => "SeatHeld", onSome: (current) => current.proposal._tag })
  const quote = Option.match(scene, { onNone: () => firstAcceptor, onSome: (current) => acceptorFor[current.proposal._tag] })
  const reacted = Option.exists(scene, (current) => current.freed.length > 0)
  return html`<figure class="loop__code paper-card" data-spot="code">
    <figcaption class="code__caption mono">
      <span>quoted from ${SOURCE_FILE}</span>
      <b>${quote.name}</b>${reacted ? html`<span>+ the reactor that fired</span>` : null}
    </figcaption>
    ${codeBlock(quote, tag)}
    ${reacted ? codeBlock(reactor, "") : null}
  </figure>`
}

const play = (representation: Representation) => {
  const scene = representation.scene
  return html`<section class="loop__play" data-state=${representation.controlState} aria-label="One step of the loop">
    <header class="loop__heading">
      <p class="loop__kicker marquee">One step</p>
      <p class="loop__state mono">${Option.match(scene, { onNone: () => "no scene yet", onSome: (current) => `scene · record ${current.seq}` })}</p>
    </header>
    <div class="loop__track">
      <ol class="loop__stations">${STATIONS.map((id, index) => station(id, index, representation))}</ol>
      <span class="loop__light" aria-hidden="true"></span>
    </div>
    ${earlierScenes(representation)}
    <dl class="ledger">
      ${proposalItem(scene)}${acceptorsItem(scene)}${reactorsItem(scene)}${stateItem(scene)}${napItem(scene)}
    </dl>
    ${codeCard(scene)}
  </section>`
}

/** The whole act, a pure function of the board: the house on the left, the step on the right. */
export const view: View<Representation, Intent> = (representation, dispatch) =>
  html`<div class="loop">${house(representation, dispatch)}${play(representation)}</div>`
