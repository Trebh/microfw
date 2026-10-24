# @mufw/example-jfb

The [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark) (JFB) keyed table,
written twice with the same markup:

| Entry | What it is |
|---|---|
| `mufw` (`src/mufw.ts`, `src/definition.ts`) | idiomatic µFW: a `SamDefinition` (`define(schemas)(behaviour)`), mounted with `layerMount` over `layerLoopLocal`, `layerInputScheduler` provided last |
| `uhtml4` (`src/uhtml4.ts`) | the control: plain uhtml 4, one state variable, one `render` per click, no µFW. The difference between the two is the cost of µFW itself, not of the renderer |

Both render through `src/table.ts` (one template for the page and the rows) and share the pure row
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

Both entries are keyed, with `htmlFor` from `uhtml/keyed` (uhtml 4.7.1): a row is
``htmlFor(rowsKey, row.id)`<tr>…</tr>` ``, which returns the same `<tr>` element for the same id on every
render, and the array hole of the `<tbody>` reorders those elements. `@mufw/view-uhtml`'s `View` returns
a `Hole`, and a hole may contain DOM nodes, so the µFW entry reaches this without changing the package.
The plain `html` tag in a `.map` is not keyed: uhtml reuses the template instance at the same position, so
rows would be recycled.

Checked in headless Chromium against the three checks of JFB's `isKeyed` (`webdriver-ts/src/isKeyed.ts`) on both
entries: swap moves the same two `<tr>` nodes and creates none, `run` replaces every row, `remove` deletes the
removed row's node, and the `<tr>` children are `td, td, a, td, a, span, td`. The JFB driver itself was not run
by this package.

Known costs of the strategy, shared by both entries:

- `htmlFor` memoizes per `(ref, key)` in a `Map` held by the ref, and uhtml 4 has no API to drop a key. The `<tr>` of a
  removed or replaced row stays referenced for as long as `rowsKey` does, so JFB's memory benchmarks that create rows
  repeatedly show it (measured in headless Chromium: the JS heap after five create/clear cycles of 1,000 rows is about
  twice the heap after one, for `mufw` and `uhtml4` alike).
- uhtml leaves one comment node (`<!--[n]-->`) in the `<tbody>` to mark the array hole. JFB's selectors address
  `tbody>tr`, so they are unaffected, but the `<tbody>` is not made of `<tr>` alone.
- Every render assigns a fresh `onclick` closure to each row's two links and to the six buttons.

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
