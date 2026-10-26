# Devtools

Living document. Source of truth: `packages/devtools/src/Panel.ts`, `Stately.ts`.

Both adapters read `HistoryPort.records`, so they work with a local model and with a remote one.

## History panel

`layerPanel(def, ports, { root, render?, html?, save? })` renders one row per record:
`#seq kind [proposal label | ↩ source seq | snapshot] → controlState`, the latest highlighted. Clicking a row
calls `travelTo(seq)` and shows that record's model and representation as JSON. The travel runs as
a fiber of the layer (`FiberSet.makeRuntime`): it sees the layer's logger and references and is
interrupted when the layer's scope closes.

`layerHistoryList(def, ports, options)` is the same panel without travel: a row click only shows
that record. It is a separate layer, not a flag on `layerPanel`, because the two need different
servers: `TravelTo` rewrites the server's model and is only served when `MUFW_RPCS` lists it (the
default does not), whereas the list needs `History` alone. Which one a page mounts is decided at its
composition root.

A proposal's label is `proposalLabel(def, proposal)` of `@mufw/core`: the definition's own label
hook when it has one (a `nest`ed definition names a child's proposal `Child/` and the child's label,
recursively: `Child/Inc`), else the proposal's tag. The panel does not know the wrapper's shape.

**Export history (JSON)** encodes the retained records with `encodeHistoryJson(def)` and hands the
text to `options.save`, default a browser download named `<definition name>-history.json`
(a `Blob` and an anchor, the DOM boundary). The file decodes back with `decodeHistoryJson(def)`.
The export runs as a fiber of the layer like the travel; a failed encoding is logged.

A travel row shows its source from the record's `travelledTo`; it does not infer it from the models. A `restore` record (a synced
instance that replaced its model with a log's snapshot) has no proposal and no source, and its row reads `snapshot`.

An `init` record opens a history: the panel drops its rows when one arrives, so a restarted server's
history replaces the old one.

The example mounts a panel from the composition root: `runPage(placement, label, devtools)` takes
the page's devtools layer. `demo.ts` passes `layerTimeTravel()` (`layerPanel`,
which needs a server that serves `TravelTo`), and so does the `worker` page, whose worker serves
`TravelTo`; the four other auction entries (`browser-only`, `server-actions`, `server-model`,
`server-owned`) pass `Layer.empty`. The `devtools` page
(`devtools.html`, `src/client/devtools.ts`) mounts `layerHistoryList` over the remote `HistoryPort`
alone (`placements/historyOnly.ts`) and the connection banner: no view, wallet, local model or action
runner, which `check:bundle` verifies. Against a server with the default `MUFW_RPCS` it follows every
record the other pages produce.

## Stately inspector

`layerStately(def, ports, inspector, { definition })`:

| Record | Sent to the inspector |
|---|---|
| `init` | `actor(actorRef, { context: model, value: controlState })` |
| `step` | `event(name, { ...proposal, type: proposalLabel(def, proposal) })`, then `snapshot(...)` with that event |
| `travel` | `snapshot(...)` with event `@mufw.travel` |
| `restore` | `snapshot(...)` with event `@mufw.restore` |

- `definition` is usually `toXStateDefinition(def, exploreGraph(def, explore, options))`.
- The inspector's manual `actor()` reads the state diagram only from `actorRef.logic.config`, so
  the actor is passed as an object carrying the definition there.
- The app creates the inspector; the package only needs the `StatelyInspector` shape it uses.
- Browsers block a popup opened without a user gesture. The example creates the inspector with
  `autoStart: false` and starts it from a button, with events buffered until then.
- The buffer is bounded (`maxDeferredEvents`), and the oldest events go first, including the
  actor registration. `replayOnStart(inspector)` wraps a startable inspector, remembers the last
  `actor(...)` and `snapshot(...)` calls, and on `start()` calls the inspector's `start()` and then
  re-sends both. Pass the wrapper to `layerStately` and call `start()` on it.
