import { type AnyDefinition, type Ports, proposalLabel, type StepKind, type StepRecord } from "@mufw/core"
import { Effect, Layer, Option, Stream } from "effect"
import { html, render } from "uhtml"
import "./historyRows.css"

/** One line of a history list: what the record is called, and the control state it left the loop in. */
export interface Row {
  readonly seq: number
  readonly kind: StepKind
  /** The proposal's label: its tag, or the wrapper path of a part's proposal. */
  readonly label: string
  /** The control state, one entry per half when a nested definition joins two with `/`. */
  readonly parts: ReadonlyArray<string>
}

export interface ListOptions<D extends AnyDefinition> {
  readonly root: Element
  /** The definition behind the loop: it names the list and labels each record's proposal. */
  readonly definition: D
  /** How many of the newest records the list shows. */
  readonly limit: number
}

const labelOf = (definition: AnyDefinition, record: StepRecord<AnyDefinition>): string =>
  Option.match(record.proposal, { onNone: () => record.kind, onSome: (proposal) => proposalLabel(definition, proposal) })

export const rowOf = (definition: AnyDefinition) => (record: StepRecord<AnyDefinition>): Row => ({
  seq: record.seq,
  kind: record.kind,
  label: labelOf(definition, record),
  parts: record.representation.controlState.split("/")
})

const noRows: ReadonlyArray<Row> = []

/** Newest first, so the list reads from the present into the past. */
const remember = (limit: number) => (rows: ReadonlyArray<Row>, row: Row): ReadonlyArray<Row> =>
  [row, ...rows].slice(0, limit)

const part = (value: string, index: number, older: Row | undefined) =>
  html`<b class="hist__part" data-changed=${String(older !== undefined && older.parts[index] !== value)}>${value}</b>`

/** A part's record is labelled through its wrapper (`Child/…`, `Nights[Fri]/…`); every other label belongs to the loop's own definition. */
const originOf = (label: string): string => (label.includes("/") ? "inner" : "own")

const recordRow = (row: Row, older: Row | undefined) =>
  html`<li class="hist__record" data-origin=${originOf(row.label)} data-kind=${row.kind} data-parity=${String(row.seq % 2)}>
    <span class="hist__seq mono">#${row.seq}</span>
    <span class="hist__label mono">${row.label}</span>
    <span class="hist__parts">${row.parts.map((value, index) => part(value, index, older))}</span>
  </li>`

const historyList = (title: string, rows: ReadonlyArray<Row>) =>
  html`<header class="hist__head">
      <h3 class="hist__title mono">${title} <span class="hist__kind">history</span></h3>
      <span class="hist__count mono">${rows.length === 0 ? "…" : `step #${rows[0]?.seq ?? 0}`}</span>
    </header>
    <ol class="hist__records">${rows.map((row, index) => recordRow(row, rows[index + 1]))}</ol>`

/**
 * One list over a loop's `HistoryPort`: its newest `limit` records, as the loop wrote them. The list
 * reads the port, not the model, so it shows exactly what a rewind would travel through.
 */
export const layerHistoryRows = <D extends AnyDefinition>(ports: Ports<D>, options: ListOptions<D>) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const history = yield* ports.HistoryPort
      const paint = (rows: ReadonlyArray<Row>) =>
        Effect.sync(() => render(options.root, historyList(options.definition.name, rows)))
      const rows = history.records.pipe(Stream.map(rowOf(options.definition)), Stream.scan(() => noRows, remember(options.limit)))
      yield* Effect.forkScoped(Stream.runForEach(rows, paint))
    })
  )
