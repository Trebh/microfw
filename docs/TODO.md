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

1. Islands of interactivity: several definitions on one page, each with its own loop, root and
   placement — the microfrontend case. `makePorts` already keys services by `def.name`.
   - `@mufw/core`: `layerForward(from: Ports<A>, to: Ports<B, R>, forward: (previous: Option<RepresentationOf<A>>, current: RepresentationOf<A>) => Option<IntentOf<B>>)`,
     a `Layer.effectDiscard` over `from.ModelPort.representations` that dispatches each `Some`
     through `to.IntentPort` and logs a `DispatchRefused` at warning level. `forward` is pure and
     sees the previous representation, so deduplication is the caller's rule, not the layer's.
   - Server: one ``RpcServer.layerProtocolWebsocket({ path: `/sam/${def.name}` })`` per served
     definition (the RPC tags stay `Submit`…`TravelTo`: separate paths avoid a wire-contract
     change); `MUFW_RPCS` applies to every definition. Client: one `layerProtocolSocket` per
     definition in `src/client/placements/transport.ts`.
   - Example: `src/domain/Wallet.ts` — model `{ credit, reserved }`, control states
     `funded | exhausted`, intents `Reserve { amount } | Release`, proposals
     `Reserved | Released | Refused` — mounted browser-only on every page beside the auction and
     fed by `layerForward` from the auction (highest bid by the page's bidder → `Reserve`,
     otherwise `Release`).
   - Done: the demo page runs the auction server-owned and the wallet browser-only; an accepted
     bid moves the wallet; `check:bundle` passes; wallet path tests; a `layerForward` test over two
     Counter fixtures with distinct names.
2. Server-rendered first paint and hybrid takeover.
   - `@mufw/view-uhtml` gains an `./ssr` entry (`src/ssr.ts`): `makeSsr()` builds a `uhtml/dom`
     `Document`, runs `uhtml/init` on it and returns `{ html, toString(hole) }` where `toString`
     renders into a detached element and reads `innerHTML`. `uhtml/ssr` is not used: the
     `dom`+`init` pair is what the tests already prove, and `initSsr` documents no `document`.
   - Server: optional `MUFW_SSR=<deployment>`; when set, GET `/` reads
     `dist/<deployment>/index.html`, renders `makeViewWith(html)(label)(current representation, () => {})`
     into `<div id="app">`, serves `dist/<deployment>/assets/*` with `HttpServerResponse.file`,
     and for browser-model deployments embeds the model encoded by `Schema.encodeSync(Auction.model)`
     in `<script type="application/json" id="mufw:Auction">`.
   - `layerModelLocal(def, ports, options?: { initial?: ModelOf<D> })` and `layerLoopLocal` accept
     an initial model; a browser-model placement decodes the embedded JSON with
     `Schema.decodeUnknownEffect(Auction.model)` at its composition root and passes it.
   - Hydration is a takeover: uhtml has no hydration API, the first representation re-renders
     identical markup, and events before mount are lost.
   - Done: `curl :3001/` returns markup with the live control state; the page is visible before
     the socket connects; a browser-only page seeded from the snapshot shows the server's bids at
     seq 0; the SSR output is asserted with the same fake-DOM harness as the DOM driver.
3. Streamed representations without a socket.
   - Read-only islands over HTTP: serve `Representations` through
     ``RpcServer.layerProtocolHttp({ path: `/sam/${def.name}/http` })`` with
     `RpcSerialization.layerNdjson`; the client uses `RpcClient.layerProtocolHttp` and the same
     `layerModelRemote`.
   - HTML over the wire: GET `/stream/<name>` answers with `HttpServerResponse.stream`, writing
     the server-rendered markup first and then, per representation, a chunk that replaces
     `#app`'s `innerHTML` — an island with no client bundle.
   - Done: both run in the demo page; first paint and update latency are compared with the socket
     placement and the comparison decides which one islands use by default.
4. Nested definitions (wizards, forms): a pure `nest(parent, child)` in `@mufw/core` producing one
   definition — model `{ parent, child }`, proposal and intent unions with a `Child` wrapper tag,
   representation `{ controlState, parent, child }` with `controlState` from an option
   `(parent, child) => string` (default: the parent's), acceptors routed by wrapper, `nap` parent
   first then child, actions delegated — plus synchronous proposal forwarding `toParent`/`toChild`
   applied in the same step so one loop, one history and one graph cover both.
   Done: the Counter fixture nested in itself passes the path tests over the local loop and
   `Rpc.layerClientTest`; devtools show one history.
5. Merge transitions observed at runtime (history) into the explored graph; export and import
   history as JSON; replay from seq N with the recorded proposals.
6. Persistence port for the model (`effect/persistence` key-value store) and multi-instance
   synchronisation of proposals via `effect/eventlog`.
7. Devtools as a standalone page fed by the `History` RPC, working against the server loop with no
   client code.
8. Model in a Web Worker (`RpcServer.layerProtocolWorkerRunner` / `RpcClient.layerProtocolWorker`),
   with no domain change.
