import { type AnyDefinition, encodeHistoryJson, type HistoryPortShape, type Ports, proposalLabel, type StepRecord } from "@mufw/core"
import { Effect, FiberSet, Layer, Option, Stream } from "effect"
import type { Hole } from "uhtml"

type Tag = (template: TemplateStringsArray, ...values: Array<unknown>) => Hole
type Render = <T>(where: T, what: Hole | (() => Hole)) => T

/** The exported history: a file name and its JSON text. */
export interface ExportedFile {
  readonly name: string
  readonly json: string
}

export interface PanelOptions {
  readonly root: Element
  /** Default: uhtml's `render` and `html`, loaded on mount because uhtml needs a DOM at import time. */
  readonly render?: Render
  readonly html?: Tag
  /** Hands an exported file to the user. Default: the browser downloads it. */
  readonly save?: (file: ExportedFile) => Effect.Effect<void>
}

/** What a row click does besides showing the record. */
type OnSelect<D extends AnyDefinition> = (history: HistoryPortShape<D>, seq: number) => Effect.Effect<void>

const loadUhtml = Effect.promise(() => import("uhtml"))

const downloadFile = (file: ExportedFile) =>
  Effect.sync(() => {
    const url = URL.createObjectURL(new Blob([file.json], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    link.download = file.name
    link.click()
    URL.revokeObjectURL(url)
  })

const travelSource = <D extends AnyDefinition>(travel: StepRecord<D>) =>
  travel.travelledTo === undefined ? "↩" : `↩ ${travel.travelledTo}`

const label = <D extends AnyDefinition>(def: D, record: StepRecord<D>) => {
  if (record.kind === "travel") return travelSource(record)
  return Option.match(record.proposal, { onNone: () => "", onSome: (proposal) => proposalLabel(def, proposal) })
}

interface Renderer {
  readonly render: Render
  readonly html: Tag
}

const loadRenderer = (options: PanelOptions): Effect.Effect<Renderer> =>
  Effect.gen(function*() {
    if (options.render && options.html) return { render: options.render, html: options.html }
    const uhtml = yield* loadUhtml
    return { render: options.render ?? uhtml.render, html: options.html ?? uhtml.html }
  })

/** The JSON of `records`, handed to `save`. The records were decoded by the port, so a failed encoding is logged, not thrown. */
const exportHistory = <D extends AnyDefinition>(
  def: D,
  records: ReadonlyArray<StepRecord<D>>,
  save: NonNullable<PanelOptions["save"]>
) =>
  encodeHistoryJson(def)(records).pipe(
    Effect.flatMap((json) => save({ name: `${def.name}-history.json`, json })),
    Effect.catchTag("SchemaError", (error) => Effect.logError(error))
  )

const travelThere = <D extends AnyDefinition>(history: HistoryPortShape<D>, seq: number) =>
  history.travelTo(seq).pipe(Effect.catchTag("NoSuchStep", (e) => Effect.logWarning(e)))

const stayHere = () => Effect.void

const layerHistoryView = <D extends AnyDefinition>(
  def: D,
  ports: Ports<D>,
  options: PanelOptions,
  onSelect: OnSelect<D>
) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const history = yield* ports.HistoryPort
      const { html, render } = yield* loadRenderer(options)
      const runFork = yield* FiberSet.makeRuntime()
      const records: Array<StepRecord<D>> = []
      let selected: number | undefined
      const select = (seq: number) => {
        selected = seq
        paint()
        runFork(onSelect(history, seq))
      }
      const save = options.save ?? downloadFile
      const exportClicked = () => runFork(exportHistory(def, records.slice(), save))
      const row = (record: StepRecord<D>, latest: number | undefined) =>
        html`<li class=${record.seq === latest ? "mufw-latest" : ""} onclick=${() => select(record.seq)}>
          #${record.seq} ${record.kind} ${label(def, record)} → ${record.representation.controlState}
        </li>`
      const paint = () => {
        const latest = records.at(-1)?.seq
        const shown = records.find((r) => r.seq === (selected ?? latest))
        const detail = shown && JSON.stringify({ model: shown.model, representation: shown.representation }, null, 2)
        render(
          options.root,
          html`<button type="button" class="mufw-export" onclick=${exportClicked}>Export history (JSON)</button>
            <ol class="mufw-history">${records.map((r) => row(r, latest))}</ol><pre>${detail}</pre>`
        )
      }
      const append = (record: StepRecord<D>) =>
        Effect.sync(() => {
          // An `init` record opens a history: a restarted server sends a new one after the old.
          if (record.kind === "init") {
            records.length = 0
            selected = undefined
          }
          records.push(record)
          paint()
        })
      yield* Effect.forkScoped(Stream.runForEach(history.records, append))
    })
  )

/**
 * Time-travel panel: one row per history record, the latest highlighted; clicking a row travels
 * there and shows that record's model and representation. A button exports the retained history as
 * JSON (`encodeHistoryJson`). Requires `HistoryPort`, and a server that serves `TravelTo` when the
 * history is remote.
 */
export const layerPanel = <D extends AnyDefinition>(def: D, ports: Ports<D>, options: PanelOptions) =>
  layerHistoryView(def, ports, options, travelThere)

/**
 * The panel without travel: a row click only shows that record, so it works against a server that
 * does not serve `TravelTo`. It has the same rows and the same export.
 */
export const layerHistoryList = <D extends AnyDefinition>(def: D, ports: Ports<D>, options: PanelOptions) =>
  layerHistoryView(def, ports, options, stayHere)
