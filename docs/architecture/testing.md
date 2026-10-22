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

A driver needs only the ports it uses, so the same path runs against `layerLoopLocal`, against
remote ports over `Rpc.layerClientTest`, or against a live server over a websocket
(`examples/auction/test/live.ts`).

`Driver<D, R, E>` types how a transition can fail: `intentDriver` fails with `DispatchRefused`, which
`TestModel.run` adds to `PathFailure`, and its `R` includes the per-request services of the ports it
was built from.

## Writing a test model

- Keep `explore` small and bounded: one representative proposal per kind of transition.
- Compute proposals from the representation and model they are tried on, not from constants.
- Run path tests with `AutoActions` false, so automatic actions cannot move the model between
  asserted steps.
- Name generated tests with `model.describe(path)`: `reaches <node> (initial)` or
  `reaches <node> via <tag> → <tag>`.
