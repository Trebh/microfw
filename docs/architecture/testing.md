# Model-based testing

Living document. Source of truth: `packages/core/src/Graph.ts`, `packages/test/src/index.ts`.

## Exploring the graph

`exploreGraph(def, explore, { key?, serialize?, limit? })` is pure.

- `explore(representation, model)` returns the sample proposals to try from a state. It is
  written next to the definition and shared by tests and the Stately adapter.
- **Nodes** are identified by `key(representation)` (default: `controlState`). The first model
  reaching a key is its representative.
- **Exploration states** are identified by `serialize(representation, model)` (default: `key`).
  Breadth-first search expands every new exploration state, so a finer `serialize` lets
  exploration continue through states that share a node but enable different transitions.
- **Edges** are `{ from, to, proposal }` between nodes, deduplicated by value.
- More than `limit` exploration states (default 1 000) throws: an unbounded `serialize` or `key`
  is a test-authoring bug.

Consumers:

| Function | Result |
|---|---|
| `shortestPaths(graph)` | one breadth-first path per node; the initial node has no steps |
| `simplePaths(graph)` | depth-first paths that never revisit an exploration state; a path that is a strict prefix of a longer path to the same node is dropped |
| `unreachableControlStates(def, graph)` | declared control states no node carries |
| `toXStateDefinition(def, graph)` | `{ id, initial, states: { [node]: { on: { [tag]: target \| [{ target }…] } } } }` |

## Merging a recorded history

`mergeHistory(graph, records, { key? })` is pure. It adds what a runtime history crossed to an
explored graph and returns a `MergedGraph`: a `Graph` plus `observed` and `unexplored` edge lists.

- A transition is a `step` record with a proposal, read against the record just before it, whatever
  that record's kind: after a `travel` the step leaves the restored state. `init` and `travel`
  records are not transitions. A step whose predecessor is not in `records` (its seq is not
  `previous.seq + 1`: evicted or not exported) has no known source and is skipped.
- Each transition becomes the edge `key(previous.representation) → key(record.representation)` labelled
  with the proposal. `key` must be the one used to explore (default: the control state).
- An edge exploration already holds is not duplicated: proposals are compared by value, whatever the
  order of their fields. It is listed in `observed` only. An edge exploration missed is appended to
  `edges`, and listed in `observed` and in `unexplored`: the sample alphabet to widen.
- A node the history reached and exploration did not is added, with the recorded model as its
  representative.
- `states` and `transitions` stay those of exploration, so `shortestPaths` and `simplePaths` still
  walk explored behaviour only. `toXStateDefinition` and `unreachableControlStates` read the merged
  `nodes` and `edges`.

## Running a path

`createTestModel(def, ports, { explore, states, key?, serialize?, limit? })` explores the graph
and throws at construction when a declared control state is unreachable. `states` holds one
assertion per node; an assertion throws to fail.

`model.run(path, driver?)`:

1. `HistoryPort.travelTo(0)` — reset to the `init` record (works locally and over RPC).
2. Read the current representation; its key must be the graph's initial node; run its assertion.
3. For each step: `driver.step(step)`, then obtain the representation —
   - immediately if `driver.appliesOnReturn` or the step is a self-loop;
   - otherwise by waiting (event-driven, up to 5 s) for a representation whose key is `step.to`.
4. The key must equal `step.to`; run that node's assertion.

Any mismatch or thrown assertion becomes `PathFailure { target, stepIndex, expected, actual, message }`
(`stepIndex` is `-1` for the initial check).

## Drivers

| Driver | Transition | Applies on return |
|---|---|---|
| `presentDriver(ports)` (default) | `ModelPort.present(step.proposal)` | yes |
| `intentDriver(ports, intentFor)` | `IntentPort.dispatch(intentFor(step))`, through the real actions | no |
| `domDriver({ painted, act, shows })` | waits for the DOM to show `step.from`, runs `act(step)` on the rendered UI, waits for it to show `step.to` | yes |

A driver needs only the ports it uses, so the same path runs against `layerLoopLocal`, against
remote ports over `Rpc.layerClientTest`, or against a live server over a websocket
(`examples/auction/test/live.ts`).

`Driver<D, R, E>` types how a transition can fail: `intentDriver` fails with `DispatchRefused`, which
`TestModel.run` adds to `PathFailure`, and its `R` includes the per-request services of the ports it
was built from.

### DOM driver

`domDriver` keeps `@mufw/test` free of DOM types: `act` (click, fill, submit; dispatch when the
step has no UI) and `shows(node)` (throws while the DOM does not show `node`) are closures the test
writes against its own document.

- `makePainted` counts the calls of the `render` it wraps (`painted.observe(render)`, passed to
  `layerMount`); `shows` is re-run after every paint until it passes.
- The wait runs on the live clock, for 2 s: paints happen in wall-clock time even under `TestClock`.
  A node never shown fails the step with `NotShown { node, message }`, `message` being the last
  assertion error.
- It applies on return: the view paints after the model holds the new representation, so once
  `step.to` is shown the runner reads the reached representation. For a self-loop the DOM check
  can pass on the previous paint; the runner's representation assertions cover that step.

`examples/auction/test/dom.ts` replays the auction's shortest and simple paths through
`layerMount`, given a `Harness`: the uhtml to render with, where to mount the view, the user
gestures (`click`, `fill`, `submit`) and how long each state stays on screen.

| Runtime | File | Root | Gestures | Pace |
|---|---|---|---|---|
| uhtml's fake DOM (`pnpm test`) | `Auction.dom.test.ts` | a detached element | events dispatched with uhtml's own `Event` | none |
| Chromium (`pnpm test:browser`) | `Auction.dom.browser.test.ts` | the page's `<body>`, styled by `src/client/style.css` | `userEvent` from `vitest/browser`: real clicks and typing through Playwright | none |
| visible Chromium (`pnpm test:browser:ui`) | the same | the same | the same | 700 ms before every step and after the path, so a person can follow it |

## Writing a test model

- Keep `explore` small and bounded: one representative proposal per kind of transition.
- Compute proposals from the representation and model they are tried on, not from constants.
- Run path tests with `AutoActions` false, so automatic actions cannot move the model between
  asserted steps.
- Name generated tests with `model.describe(path)`: `reaches <node> (initial)` or
  `reaches <node> via <tag> → <tag>`.
