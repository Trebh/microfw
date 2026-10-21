import type { AnyDefinition, Ports, StepRecord } from "@mufw/core"
import { Effect, Layer, Option, Stream } from "effect"
import type { Hole } from "uhtml"

type Tag = (template: TemplateStringsArray, ...values: Array<unknown>) => Hole
type Render = <T>(where: T, what: Hole | (() => Hole)) => T

export interface PanelOptions {
  readonly root: Element
  /** Default: uhtml's `render` and `html`, loaded on mount because uhtml needs a DOM at import time. */
  readonly render?: Render
  readonly html?: Tag
}

const loadUhtml = Effect.promise(() => import("uhtml"))

/** A travel record does not carry its source; the latest earlier non-travel record with the same model is it. */
const travelSource = <D extends AnyDefinition>(records: ReadonlyArray<StepRecord<D>>, travel: StepRecord<D>) => {
  const model = JSON.stringify(travel.model)
  const source = records.findLast((r) => r.seq < travel.seq && r.kind !== "travel" && JSON.stringify(r.model) === model)
  return source === undefined ? "↩" : `↩ ${source.seq}`
}

const label = <D extends AnyDefinition>(records: ReadonlyArray<StepRecord<D>>, record: StepRecord<D>) => {
  if (record.kind === "travel") return travelSource(records, record)
  return Option.match(record.proposal, { onNone: () => "", onSome: (proposal) => proposal._tag })
}

/**
 * Time-travel panel: one row per history record, the latest highlighted; clicking a row travels
 * there and shows that record's model and representation. Requires `HistoryPort`.
 */
export const layerPanel = <D extends AnyDefinition>(ports: Ports<D>, options: PanelOptions) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const history = yield* ports.HistoryPort
      const uhtml = options.render && options.html ? undefined : yield* loadUhtml
      const render: Render = options.render ?? uhtml!.render
      const html: Tag = options.html ?? uhtml!.html
      const records: Array<StepRecord<D>> = []
      let selected: number | undefined
      const select = (seq: number) => {
        selected = seq
        Effect.runFork(history.travelTo(seq).pipe(Effect.catchTag("NoSuchStep", (e) => Effect.logWarning(e))))
      }
      const row = (record: StepRecord<D>, latest: number) =>
        html`<li class=${record.seq === latest ? "mufw-latest" : ""} onclick=${() => select(record.seq)}>
          #${record.seq} ${record.kind} ${label(records, record)} → ${record.representation.controlState}
        </li>`
      const paint = () => {
        const latest = records.length - 1
        const shown = records[selected ?? latest]
        const detail = shown && JSON.stringify({ model: shown.model, representation: shown.representation }, null, 2)
        render(options.root, html`<ol class="mufw-history">${records.map((r) => row(r, latest))}</ol><pre>${detail}</pre>`)
      }
      const append = (record: StepRecord<D>) =>
        Effect.sync(() => {
          records.push(record)
          paint()
        })
      yield* Effect.forkScoped(Stream.runForEach(history.records, append))
    })
  )
