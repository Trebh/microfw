import { html, render } from "uhtml"

interface Row {
  readonly id: number
  readonly on: boolean
}

/** The plain baseline of `list-mufw`: uhtml, one state variable, one render function, no `effect`. */
const ROWS = 1000

let rows: ReadonlyArray<Row> = Array.from({ length: ROWS }, (_, id) => ({ id, on: false }))

const root = document.getElementById("app")!

const rowView = (row: Row) =>
  html`<li data-id=${row.id}><button onclick=${() => toggle(row.id)}>${row.on ? "on" : "off"}</button></li>`

const view = () =>
  html`<output id="on">${rows.filter((row) => row.on).length}</output><ul id="rows">${rows.map(rowView)}</ul>`

const paint = () => render(root, view())

function toggle(id: number) {
  rows = rows.map((row) => (row.id === id ? { id: row.id, on: !row.on } : row))
  paint()
}

paint()
