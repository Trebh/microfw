# Devtools

Living document. Source of truth: `packages/devtools/src/Panel.ts`, `Stately.ts`.

Both adapters read `HistoryPort.records`, so they work with a local model and with a remote one.

## Time-travel panel

`layerPanel(ports, { root, render?, html? })` renders one row per record:
`#seq kind [proposal tag | ↩ source seq] → controlState`, the latest highlighted. Clicking a row
calls `travelTo(seq)` and shows that record's model and representation as JSON. The travel runs as
a fiber of the layer (`FiberSet.makeRuntime`): it sees the layer's logger and references and is
interrupted when the layer's scope closes.

A travel row shows its source from the record's `travelledTo`; it does not infer it from the models.

An `init` record opens a history: the panel drops its rows when one arrives, so a restarted server's
history replaces the old one.

Row clicks call `TravelTo`, which a server only serves when `MUFW_RPCS` lists it (the default
does not). The example therefore mounts the panel from the composition root: `runPage(placement,
label, devtools)` takes the page's devtools layer. `demo.ts` passes `layerTimeTravel()`; the four
production entries (`browser-only`, `server-actions`, `server-model`, `server-owned`) pass
`Layer.empty`.

## Stately inspector

`layerStately(def, ports, inspector, { definition })`:

| Record | Sent to the inspector |
|---|---|
| `init` | `actor(actorRef, { context: model, value: controlState })` |
| `step` | `event(name, { ...proposal, type: proposal._tag })`, then `snapshot(...)` with that event |
| `travel` | `snapshot(...)` with event `@mufw.travel` |

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
