# TODO

Living document. Add an item when a gap is found; delete it in the change that closes it (the
history lives in git). Each item names where the gap is and what done looks like.

## Known gaps

### Parse, don't validate

- [ ] **Placement query.** `examples/auction/src/placement.ts` splits `location.search` by hand.
  Done: a `Schema` decodes the query into `Placement`, invalid input falls back through the decode
  result, and the parser has tests for each fallback.
- [ ] **Bid form input.** `examples/auction/src/view.ts` sends `Number(formData.get("amount"))`,
  which can be `NaN` or non-integer; the `Int` schema only rejects it when it crosses the wire, and
  not at all with local actions. Done: the form value is decoded at the DOM boundary and an
  invalid amount never becomes an intent.
- [ ] **Environment.** `server.ts` and `test/live.ts` read `process.env` directly. Done:
  `Config.Literals(["on", "off"], "MUFW_AUTO_ACTIONS")` and `Config.String("MUFW_SERVER")` (with
  defaults), so a misconfiguration fails at start with a typed error.
- [ ] **Domain refinements.** Amounts and bidders are bare `Int`/`String`. Done: branded schemas
  (e.g. a positive `Amount`) used by model, proposals and intents, so acceptors stop re-checking.

### Effect boundaries

- [ ] **DOM handlers run on the default runtime.** `layerMount`'s `dispatch` and `layerPanel`'s row
  click use `Effect.runFork`, which drops the application's logger, tracer and references. Done: both
  capture a runner from the layer (`FiberSet.makeRuntime` or `Effect.runForkWith(context)`), so
  fibers started by the DOM are supervised by and interrupted with the layer.
- [ ] **Clock origin of the auction.** `initial` uses `Date.now()` at module load, so every process
  has its own auction start and the server's auction starts when the process does. Done: the start
  time comes from the environment of the composition root (Clock or Config), and resetting the
  auction does not need a restart.

### Loop semantics

- [ ] **Travel and in-flight actions.** An automatic action running during `travelTo` still
  presents afterwards (a pending `Tick` moves `now` back to wall time). Decide: interrupt in-flight
  automatic actions on travel, or tag proposals with the seq they were computed from and drop stale
  ones. Add a test for the chosen rule.
- [ ] **Defects in action fibers.** `ActionsDrain` forks each action with `forkScoped` and handles
  only `ActionFailure`. Decide and test what happens to a defect (log, surface to devtools, stop).
- [ ] **Unbounded history.** Records are kept in memory forever. Done: a retention policy (count or
  age) with `travelTo` failing `NoSuchStep` for evicted steps, or persistence behind a port.
- [ ] **Travel records lack their source.** The panel infers it by model equality. Done: the record
  carries the travelled-to seq, and the panel reads it.

### Types

- [ ] **Casts around generic definitions.** `stepRecordSchema`, `makeRpc` (client and `Dispatch`
  handler) cast because a generic `D` erases schema types. Done: each cast is removed, or kept with
  a type-level test proving the concrete types it stands for.

### Transport

- [ ] **No reconnection story.** A lost websocket is a defect. Done: reconnection policy configured
  on `layerProtocolSocket`, and the view shows a disconnected state.

### Tooling

- [ ] **No CI.** Done: a pipeline running `pnpm typecheck` and `pnpm test` on every change.
- [ ] **No build or publish.** Packages export TypeScript sources. Done when a consumer outside the
  workspace needs them: a build to `dist` and `exports` pointing at it.
- [ ] **Stately buffer.** The example buffers at most 10 000 inspector events before the popup is
  opened; older ones (including the actor registration) are dropped. Done: re-send the actor and the
  latest snapshot when the inspector starts.

## Roadmap

In rough order; each becomes a set of gaps above when started.

1. Browser driver for `@mufw/test`: replay paths by clicking the rendered UI and reading the DOM.
2. Merge transitions observed at runtime (history) into the explored graph; export and import
   history as JSON; replay from seq N with the recorded proposals.
3. Persistence port for the model (`effect/persistence` key-value store) and multi-instance
   synchronisation of proposals via `effect/eventlog`.
4. Child SAM instances (wizards, forms) composed as nested definitions, with proposal forwarding
   between parent and child.
5. Devtools as a standalone page fed by the `History` RPC, working against the server loop with no
   client code.
6. Model in a Web Worker (`RpcServer.layerProtocolWorkerRunner` / `RpcClient.layerProtocolWorker`),
   with no domain change.
7. Server-rendered first paint with `uhtml/ssr` from the server's current representation.
