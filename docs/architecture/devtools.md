# Devtools

Living document. Source of truth: `packages/devtools/src/Panel.ts`, `Stately.ts`.

Both adapters read `HistoryPort.records`, so they work with a local model and with a remote one.

## Time-travel panel

`layerPanel(ports, { root, render?, html? })` renders one row per record:
`#seq kind [proposal tag | ↩ source seq] → controlState`, the latest highlighted. Clicking a row
calls `travelTo(seq)` and shows that record's model and representation as JSON.

A travel record does not carry the record it came from; the panel shows the latest earlier
non-travel record with the same model.

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
