import { render } from "uhtml"
import { htmlFor } from "uhtml/keyed"
import { makeLabels } from "./labels.ts"
import { makePlainKeyedRows } from "./plainKeyedRows.ts"
import { CREATE_COUNT, CREATE_LOTS_COUNT, type Row, swapRows, updateEveryTenth, withLabels } from "./rows.ts"
import { type Handlers, makeTableView } from "./Table.view.ts"

const TITLE = "uhtml4-\"keyed\""

const tableView = makeTableView(makePlainKeyedRows(htmlFor))

/** The plain baseline of `mufw`: one state variable, replaced on every click, then one `render`. */
interface State {
  readonly rows: ReadonlyArray<Row>
  readonly selected: number | null
  readonly nextId: number
}

let state: State = { rows: [], selected: null, nextId: 1 }

const root = document.getElementById("main")!

const paint = () => render(root, tableView(TITLE, state.rows, state.selected, handlers))

const setState = (next: State) => {
  state = next
  paint()
}

const createRows = (count: number) => withLabels(state.nextId, makeLabels(count, Math.random))

const replace = (count: number) =>
  setState({ rows: createRows(count), selected: null, nextId: state.nextId + count })

const append = () =>
  setState({
    rows: state.rows.concat(createRows(CREATE_COUNT)),
    selected: state.selected,
    nextId: state.nextId + CREATE_COUNT
  })

const handlers: Handlers = {
  run: () => replace(CREATE_COUNT),
  runLots: () => replace(CREATE_LOTS_COUNT),
  add: append,
  update: () => setState({ ...state, rows: updateEveryTenth(state.rows) }),
  clear: () => setState({ ...state, rows: [], selected: null }),
  swapRows: () => setState({ ...state, rows: swapRows(state.rows) }),
  select: (id) => setState({ ...state, selected: id }),
  remove: (id) => setState({ ...state, rows: state.rows.filter((row) => row.id !== id) })
}

paint()
