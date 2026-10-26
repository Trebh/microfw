import { html } from "uhtml"
import type { Tag, Target } from "uhtml/keyed"
import type { Row } from "./rows.ts"

/** What the page can ask for; each entry wires these to its own state handling. */
export interface Handlers {
  readonly run: () => void
  readonly runLots: () => void
  readonly add: () => void
  readonly update: () => void
  readonly clear: () => void
  readonly swapRows: () => void
  readonly select: (id: number) => void
  readonly remove: (id: number) => void
}

/**
 * One node per row, the same node for the same key on every render, and none kept for a key the latest
 * render lacks. Declared here, not imported, because the plain entry imports no `@mufw/*`; each entry
 * passes its own implementation.
 */
export type KeyedRows = <T>(
  items: ReadonlyArray<T>,
  keyOf: (item: T) => string | number,
  build: (tag: Tag, item: T) => Target
) => ReadonlyArray<Target>

const rowView = (tag: Tag, row: Row, selected: number | null, handlers: Handlers) =>
  tag`<tr class=${row.id === selected ? "danger" : null}><td class="col-md-1">${row.id}</td><td class="col-md-4"><a onclick=${() => handlers.select(row.id)}>${row.label}</a></td><td class="col-md-1"><a onclick=${() => handlers.remove(row.id)}><span class="glyphicon glyphicon-remove" aria-hidden="true"></span></a></td><td class="col-md-6"></td></tr>`

const button = (id: string, text: string, onclick: () => void) =>
  html`<div class="col-sm-6 smallpad"><button type="button" class="btn btn-primary btn-block" id=${id} onclick=${onclick}>${text}</button></div>`

const jumbotron = (title: string, handlers: Handlers) =>
  html`<div class="jumbotron"><div class="row"><div class="col-md-6"><h1>${title}</h1></div><div class="col-md-6"><div class="row">${
    button("run", "Create 1,000 rows", handlers.run)
  }${button("runlots", "Create 10,000 rows", handlers.runLots)}${button("add", "Append 1,000 rows", handlers.add)}${
    button("update", "Update every 10th row", handlers.update)
  }${button("clear", "Clear", handlers.clear)}${button("swaprows", "Swap Rows", handlers.swapRows)}</div></div></div></div>`

/**
 * The page of the js-framework-benchmark table: jumbotron, keyed rows, the preloaded glyphicon. The
 * keyed list is the state of the `<tbody>`, so each table view takes one instance of `keyedRows`.
 */
export const makeTableView = (keyedRows: KeyedRows) =>
(title: string, rows: ReadonlyArray<Row>, selected: number | null, handlers: Handlers) =>
  html`<div class="container">${jumbotron(title, handlers)}<table class="table table-hover table-striped test-data"><tbody id="tbody">${
    keyedRows(rows, (row) => row.id, (tag, row) => rowView(tag, row, selected, handlers))
  }</tbody></table><span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true"></span></div>`
