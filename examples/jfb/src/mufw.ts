import { BrowserRuntime } from "@effect/platform-browser"
import { type IntentOf, layerLoopLocal, type RepresentationOf } from "@mufw/core"
import { layerInputScheduler, layerMount, type View } from "@mufw/view-uhtml"
import { Effect, Layer } from "effect"
import { Table, TablePorts } from "./Table.ts"
import { type Handlers, tableView } from "./Table.view.ts"

type Intent = IntentOf<typeof Table>
type Representation = RepresentationOf<typeof Table>

const TITLE = "µFW-\"keyed\""

const handlersOf = (dispatch: (intent: Intent) => void): Handlers => ({
  run: () => dispatch({ _tag: "Run" }),
  runLots: () => dispatch({ _tag: "RunLots" }),
  add: () => dispatch({ _tag: "Add" }),
  update: () => dispatch({ _tag: "Update" }),
  clear: () => dispatch({ _tag: "Clear" }),
  swapRows: () => dispatch({ _tag: "SwapRows" }),
  select: (id) => dispatch({ _tag: "Select", id }),
  remove: (id) => dispatch({ _tag: "Remove", id })
})

const view: View<Representation, Intent> = (representation, dispatch) =>
  tableView(TITLE, representation.rows, representation.selected, handlersOf(dispatch))

const page = layerMount(TablePorts, {
  root: document.getElementById("main")!,
  view,
  onRefused: () => Effect.void
}).pipe(Layer.provide(layerLoopLocal(Table, TablePorts)), Layer.provide(layerInputScheduler))

BrowserRuntime.runMain(Layer.launch(page))
