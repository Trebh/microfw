import { Option } from "effect"
import { html } from "uhtml"
import type { Intent as SeatIntent, SeatView } from "../../domain/BoxOffice.ts"
import { LEASE_TIMEOUT_MILLIS, type Side } from "./house.ts"
import { agreement, type Agreement, chairHolder, type Scene, silenceMillis, silenceShare, type WindowScene } from "./scene.ts"
import { type Intent as StageIntent, raceableSeat } from "./stagehand.ts"
import { type Row, verdictFor } from "./tape.ts"

/** What a hand on the page can do: an intent for one window's loop, or one for the stage manager's. */
export interface Hands {
  readonly seat: (side: Side, intent: SeatIntent) => void
  readonly stage: (intent: StageIntent) => void
}

const ROWS = ["A", "B", "C"] as const

const seatsOfRow = (seats: ReadonlyArray<SeatView>, row: string) => seats.filter((seat) => seat.id.startsWith(row))

const initialOf = (name: string): string => name.slice(0, 1)

const intentFor = (seat: SeatView, mine: boolean): Option.Option<SeatIntent> => {
  if (seat.status === "free") return Option.some({ _tag: "Hold", seat: seat.id })
  if (seat.status === "held" && mine) return Option.some({ _tag: "Pay", seat: seat.id })
  return Option.none()
}

const seatButton = (side: Side, window: WindowScene, open: boolean, hands: Hands) => (seat: SeatView) => {
  const mine = Option.exists(seat.by, (by) => by === window.patron)
  const intent = intentFor(seat, mine)
  const holder = Option.getOrElse(seat.by, () => "")
  const act = () => {
    if (Option.isSome(intent)) hands.seat(side, intent.value)
  }
  return html`<button
    class="seat"
    type="button"
    data-status=${seat.status}
    data-mine=${String(mine)}
    data-seat=${seat.id}
    aria-label=${`${seat.id} ${seat.status}${holder === "" ? "" : ` by ${holder}`}`}
    ?disabled=${!open || Option.isNone(intent)}
    onclick=${act}
  >
    <span class="seat__id mono">${seat.id}</span>
    <span class="seat__by">${initialOf(holder)}</span>
  </button>`
}

const seatRow = (side: Side, window: WindowScene, open: boolean, hands: Hands, seats: ReadonlyArray<SeatView>) => (row: string) =>
  html`<div class="win__row">${seatsOfRow(seats, row).map(seatButton(side, window, open, hands))}</div>`

const verdictLine = (scene: Scene, window: WindowScene) =>
  Option.match(verdictFor(scene.tape, window.patron), {
    onNone: () => html`<span class="win__quiet">no proposal from this window yet</span>`,
    onSome: (verdict) =>
      html`<span class="win__verdict-seq mono">entry ${verdict.seq}</span>
        <span class="win__verdict-label mono">${verdict.label}</span>
        <strong class="win__verdict-word" data-refused=${String(verdict.refused)}>${verdict.refused ? verdict.detail : "accepted"}</strong>`
  })

const counts = (window: WindowScene) =>
  Option.match(window.seats, {
    onNone: () => "not open yet",
    onSome: (seats) => `${seats.free} free · ${seats.held} held · ${seats.sold} sold`
  })

const appliedText = (window: WindowScene) =>
  Option.match(window.applied, { onNone: () => "no entries applied yet", onSome: (applied) => `applied up to entry ${applied.sequence}` })

const slowLineNote = (scene: Scene) =>
  scene.onTheWire === 0
    ? html`<p class="win__wire win__wire--quiet mono">line to the log: ${scene.stage.slowLine ? "slow, nothing on it" : "normal"}</p>`
    : html`<p class="win__wire offstage mono">${scene.onTheWire} proposal${scene.onTheWire === 1 ? "" : "s"} on the way to the log</p>`

const ticketWindow = (side: Side, scene: Scene, hands: Hands) => {
  const window = side === "A" ? scene.a : scene.b
  const open = side === "B" || scene.stage.controlState === "both-open"
  const seats = Option.match(window.seats, { onNone: () => [], onSome: (representation) => representation.seats })
  return html`<section
    class=${`win win--${side.toLowerCase()}`}
    data-side=${side}
    data-open=${String(open)}
    data-chair=${String(window.holdsChair)}
  >
    <header class="win__head">
      <h2 class="win__name marquee">Window ${side}</h2>
      <p class="win__patron">acting for <em>${window.patron}</em></p>
      <p class="win__chair marquee" data-lit=${String(window.holdsChair)}>
        <span class="win__lamp"></span>${window.holdsChair ? "holds the lease" : "doesn't hold the lease"}
      </p>
    </header>
    <div class="win__house" role="group" aria-label=${`The house, seen from window ${side}`}>
      ${ROWS.map(seatRow(side, window, open, hands, seats))}
    </div>
    <p class="win__counts mono">${counts(window)}</p>
    <p class="win__applied mono">${appliedText(window)}</p>
    <p class="win__verdict"><span class="win__verdict-title marquee">The log's answer to this window</span> ${verdictLine(scene, window)}</p>
    ${side === "B" ? slowLineNote(scene) : html`<p class="win__wire win__wire--quiet mono">line to the log: direct</p>`}
    <p class="win__shutter marquee" ?hidden=${open}>window closed</p>
  </section>`
}

const detailOf = (row: Row): string => {
  if (row.renewals === 0) return row.detail
  const times = row.renewals + 1
  return row.detail === "renewed" ? `renewed ${times} times` : `${row.detail}, renewed ${row.renewals === 1 ? "once" : `${row.renewals} times`}`
}

const tapeRow = (row: Row) =>
  html`<li
    class="tape__row"
    data-event=${row.event}
    data-refused=${String(row.refused)}
    data-seq=${row.seq}
  >
    <span class="tape__seq mono">${String(row.seq).padStart(3, "0")}</span>
    <span class="tape__event">${row.event}</span>
    <span class="tape__label mono">${row.label}</span>
    <span class="tape__detail">${detailOf(row)}</span>
  </li>`

const agreementBadge = (state: Agreement) => {
  switch (state._tag) {
    case "agreed":
      return html`<span class="badge__lamp"></span><span class="badge__text">both agree at entry ${state.sequence}</span>`
    case "catching-up":
      return html`<span class="badge__lamp"></span><span class="badge__text">window ${state.behind} is catching up to entry ${state.sequence}</span>`
    case "diverged":
      return html`<span class="badge__lamp"></span><span class="badge__text">the windows differ at entry ${state.sequence}</span>`
    case "alone":
      return html`<span class="badge__lamp"></span><span class="badge__text">window A is closed, B sells alone</span>`
    case "joining":
      return html`<span class="badge__lamp"></span><span class="badge__text">the windows are joining the log</span>`
  }
}

const holderText = (scene: Scene): string =>
  Option.match(chairHolder(scene), {
    onNone: () => (scene.tape.lease.epoch === 0 ? "nobody yet" : "nobody, waiting for the timeout"),
    onSome: (side) => `window ${side}`
  })

const silenceText = (scene: Scene): string =>
  Option.match(silenceMillis(scene), {
    onNone: () => "no lease entry in the log yet",
    onSome: (millis) => `${(millis / 1000).toFixed(1)} s of silence. Another window takes over at ${LEASE_TIMEOUT_MILLIS / 1000} s`
  })

const lease = (scene: Scene) =>
  html`<div class="lease" data-spot="lease" data-vacant=${String(Option.isNone(chairHolder(scene)))}>
    <p class="lease__line">
      <span class="lease__title marquee">The lease</span>
      <span class="lease__epoch mono">term ${scene.tape.lease.epoch}</span>
    </p>
    <p class="lease__holder">${holderText(scene)}</p>
    <div class="lease__meter" style=${`--progress: ${silenceShare(scene).toFixed(3)}`}><span class="lease__bar"></span></div>
    <p class="lease__note mono">${silenceText(scene)}</p>
    <p class="lease__rule">Only the holder runs the automatic actions.</p>
  </div>`

const raceLabel = (scene: Scene): string =>
  Option.match(Option.flatMap(scene.b.seats, raceableSeat), {
    onNone: () => "no free seat to reach for",
    onSome: (seat) => `both reach for ${seat}`
  })

const controls = (scene: Scene, hands: Hands) => {
  const slow = scene.stage.slowLine
  const aOpen = scene.stage.controlState === "both-open"
  const canRace = aOpen && Option.isSome(Option.flatMap(scene.b.seats, raceableSeat))
  return html`<div class="sync__controls">
    <button
      class="stage-button"
      type="button"
      data-spot="race"
      ?disabled=${!canRace}
      onclick=${() => hands.stage({ _tag: "Race", slowLine: slow })}
    >
      <span class="lamp"></span>${raceLabel(scene)}
    </button>
    <button
      class="stage-button"
      type="button"
      data-spot="slow-line"
      aria-pressed=${String(slow)}
      onclick=${() => hands.stage({ _tag: "SetSlowLine", slow: !slow })}
    >
      <span class="lamp"></span>slow down the line to window B
    </button>
    <button
      class="stage-button"
      type="button"
      data-spot="close-a"
      onclick=${() => hands.stage(aOpen ? { _tag: "CloseWindowA" } : { _tag: "ReopenWindowA" })}
    >
      ${aOpen ? "close window A" : "reopen window A"}
    </button>
  </div>`
}

export const view = (scene: Scene, hands: Hands) => {
  const state = agreement(scene)
  return html`<div class="sync">
    <p class="sync__kicker marquee">Two windows <span class="past-35">one house, one shared log</span></p>
    <div class="badge" data-spot="agreed" data-state=${state._tag} role="status">${agreementBadge(state)}</div>
    <div class="sync__stage" data-spot="windows">
      ${ticketWindow("A", scene, hands)}
      <section class="tape" data-spot="log" aria-label="The log">
        <header class="tape__head">
          <h2 class="tape__title marquee">The log</h2>
          <p class="tape__count mono">
            ${Option.match(scene.tape.lastSeq, { onNone: () => "empty", onSome: (seq) => `${seq + 1} entries, newest first` })}
          </p>
        </header>
        <ol class="tape__rows">${scene.tape.rows.map(tapeRow)}</ol>
        ${lease(scene)}
      </section>
      ${ticketWindow("B", scene, hands)}
    </div>
    ${controls(scene, hands)}
  </div>`
}
