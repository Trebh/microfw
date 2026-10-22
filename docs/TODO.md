# TODO

Living document. Add an item when a gap is found; delete it in the change that closes it (the
history lives in git). Each item names where the gap is and what done looks like.

## Known gaps

### Transport

- [ ] **Calls while disconnected.** The protocol redials and the remote streams resubscribe, but a
  `Submit`, `Present`, `Dispatch` or `TravelTo` made while the socket is down is still a defect.
  Done: such calls are queued until the connection returns or fail with a typed error the page
  shows, with a test over a fake socket.

### Tooling

- [ ] **No build or publish.** Packages export TypeScript sources. Done when a consumer outside the
  workspace needs them: a build to `dist` and `exports` pointing at it.

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
