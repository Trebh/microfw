# @mufw/example-jfb

The [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark) (JFB) keyed table,
written twice with the same markup:

| Entry | What it is |
|---|---|
| `mufw` (`src/mufw.ts`, `src/Table.ts`) | idiomatic µFW: a `SamDefinition` (`define(schemas)(behaviour)`), mounted with `layerMount` over `layerLoopLocal`, `layerInputScheduler` provided last |
| `uhtml4` (`src/uhtml4.ts`) | the control: plain uhtml 4, one state variable, one `render` per click, no µFW. The difference between the two is the cost of µFW itself, not of the renderer |

Both render through `src/Table.view.ts` (one template for the page and the rows) and share the pure row
operations of `src/rows.ts` and the word lists of `src/labels.ts`.

```sh
pnpm --filter @mufw/example-jfb build                        # out/keyed/{mufw,uhtml4}, and the gzip size of each dist/main.js
pnpm --filter @mufw/example-jfb jfb:install <jfb-checkout>   # copies both into <jfb-checkout>/frameworks/keyed/, replacing them
```

Each `out/keyed/<name>` holds what a JFB framework directory holds after its build: `index.html`,
`dist/main.js` (one minified ES module, no other chunk), `package.json` with the `js-framework-benchmark`
metadata, and a `package-lock.json` (JFB lists a directory only when it has one; nothing is installed in
it). `build-prod` is `exit 0`: JFB serves the directory as it is. `frameworkVersion` is `@mufw/core`'s
version for `mufw` and the installed uhtml's for `uhtml4`.

## What the µFW entry has on

Nothing is turned off to help the figure.

- **History**: every step is recorded (`HistoryLimit` and `HistoryRetainedSize` at their defaults), and a step
  that copies the rows array costs a record that shares its elements with the previous one.
- **Schemas**: model, intents, proposals and representation are `Schema`s, and the definition's types come from
  them. A local loop crosses no boundary, so it decodes nothing per click; a remote placement would decode at each hop.
- **Pure acceptors**: the labels JFB draws at random are drawn in the actions, from Effect's `Random` service
  (`Random.Random`, with the benchmark's own `_random`), and travel in the `Replaced` and `Appended` proposals. The
  ids come from `nextId` in the model, so the acceptors stay pure.
- **Selection** is one `selected` id in the model (not a flag per row), and it is part of the history like any other state.

## Rendering strategy

Both entries are keyed with uhtml 4.7.1's `htmlFor` from `uhtml/keyed`, through a keyed list whose memo holds
the keys of the latest render only: a row is ``tag`<tr>…</tr>` ``, where `tag` is the bound tag of `row.id`, which
renders the same `<tr>` element for the same id on every render, and the array hole of the `<tbody>` reorders those
elements. `mufw` takes the list from `makeKeyedList` of `@mufw/view-uhtml`; `uhtml4` imports no `@mufw/*`, so
`src/plainKeyedRows.ts` is a copy of that mechanism, the same dozen lines, and the comparison between the two stays
like-for-like. `src/Table.view.ts` takes the list as a parameter (`makeTableView(keyedRows)`) and each entry makes one
instance for its one `<tbody>`. `@mufw/view-uhtml`'s `View` returns a `Hole`, and a hole may contain DOM nodes, so the
µFW entry reaches this without changing the package. The plain `html` tag in a `.map` is not keyed: uhtml reuses the
template instance at the same position, so rows would be recycled.

Checked in headless Chromium against the three checks of JFB's `isKeyed` (`webdriver-ts/src/isKeyed.ts`) on both
entries: swap moves the same two `<tr>` nodes and creates none, `run` replaces every row, `remove` deletes the
removed row's node, and the `<tr>` children are `td, td, a, td, a, span, td`. The JFB driver itself was not run
by this package.

Known costs of the strategy, shared by both entries:

- `htmlFor(ref, key)` memoizes a bound tag, and with it the row's `<tr>`, per key in a `Map` held by the ref, and uhtml 4
  has no API to drop a key. Rows would stay referenced for as long as the ref lives, so the keyed list takes each new
  key's tag from a throwaway ref (`htmlFor({}, key)`) and keeps its own map, rebuilt on every render from the rows
  it was given: a removed or replaced row's `<tr>` is unreachable after the next render. Nothing else in uhtml holds it:
  the array hole keeps only the previous render's node list, replaced by the next, and event listeners live in a
  `WeakMap` keyed by element. Memory figures are under [Memory](#memory).
- uhtml leaves one comment node (`<!--[n]-->`) in the `<tbody>` to mark the array hole. JFB's selectors address
  `tbody>tr`, so they are unaffected, but the `<tbody>` is not made of `<tr>` alone.
- Every render assigns a fresh `onclick` closure to each row's two links and to the six buttons.

## Memory

Measured with JFB's own runner, headless Chromium, the three memory benchmarks, `mufw`, `uhtml4` and `vanillajs` in
the same session, five sessions (one sample each per session; JFB takes one sample per run):

```sh
cd <jfb-checkout>/webdriver-ts
node dist/benchmarkRunner.js --headless true --framework keyed/vanillajs keyed/uhtml4 keyed/mufw --benchmark 21_ 22_ 25_
```

| MiB, median of 5 (range) | `vanillajs` | `uhtml4` | `mufw` |
|---|---|---|---|
| `21_ready-memory` | 0.567 (0.559–0.568) | 0.627 (0.549–0.628) | 1.328 (1.321–1.358) |
| `22_run-memory` | 1.870 (1.794–1.872) | 2.354 (2.347–2.355) | 3.130 (3.092–3.159) |
| `25_run-clear-memory` | 0.643 (0.592–0.650) | 0.770 (0.765–0.773) | 2.106 (2.104–2.107) |
| `25_run-clear-memory`, ratio to `vanillajs` | 1× | 1.20× | **3.28×** |

Before the keyed list released rows (`htmlFor` with a fixed ref, one sample each, a different session): `mufw`
9.46 MiB and `uhtml4` 8.41 MiB, against 0.64 for `vanillajs`.

What is left of `mufw`'s 1.34 MiB over `uhtml4` after create and clear ×5:

- **Loading µFW and Effect**: 0.70 MiB of it is already there after load (`21_ready-memory`, 1.328 against 0.627).
- **History**: about 0.42 MiB. The same entry built with `HistoryLimit` at 2 (a throwaway build, not kept; three
  sessions) ends at 1.671–1.698 MiB against 2.101–2.107 MiB for the default 1,000 records, measured in the same
  sessions. The five `Replaced` records each hold a model with 1,000 rows, and a cleared table does not free them while
  they are within the limit. `@mufw/core`'s history is unchanged.
- The remaining 0.21 MiB (derived: 1.336 − 0.701 − 0.42) is not attributed; it is the part of the Effect runtime's working state (fibers, queues,
  closures) that a run touches and the control has none of [inference].

Limits: one sample per benchmark per session, headless rather than JFB's default headed window, Google Chrome
156.0.8078.48 on an Apple M5, JFB commit `3ab4cea`; compare within a session only.

## JFB flags

None is declared in `package.json` (`issues` is empty). This is how each applies, from JFB's contributing rules:

| JFB note | `mufw` | `uhtml4` |
|---|---|---|
| #772 manual DOM manipulation | no: the view is a template | no |
| #796 `requestAnimationFrame` in client code | no (the input scheduler uses microtasks and `setTimeout`) | no |
| #800 selection flag per row | no: one `selected` id in the model | no: one `selected` id in the state |
| #801 explicit event delegation | no: uhtml assigns `onclick` to each element, the click becomes an intent | no |
| view state in the model | the selected id is model state, recorded in the history | plain variable |

## Where this differs from JFB's reference

- The markup follows the current `frameworks/keyed/vanillajs/index.html` and what `isKeyed` checks: the label and
  remove links are bare `<a>`, the icon is `<span class="glyphicon glyphicon-remove" aria-hidden="true">`. A row has no
  `class` attribute until it is selected.
- The jumbotron and the table are rendered by the view into `<div id="main">`, so `#run` and the other buttons exist once
  the script has run, not in the static HTML. The `<h1>` is `µFW-"keyed"` and `uhtml4-"keyed"`.
- Selection survives `update`, `add` and `swaprows`; `run`, `runlots` and `clear` drop it. The `Select` and `Remove`
  intents carry the row id.
