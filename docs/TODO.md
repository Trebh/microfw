# TODO

Living document. Add an item when a gap is found; delete it in the change that closes it (the
history lives in git). Each item names where the gap is and what done looks like.

## Known gaps

### Transport

- [ ] **A held call dies on a second drop.** `layerHoldRequestsWhileDisconnected` (`@mufw/rpc`)
  holds a call made while the socket is down, but if the connection drops again after a redial and
  before the call is written, the protocol's error broadcast fails it as a defect. Done: a call that
  was never written stays held across any number of drops, with a test over the in-memory socket.
- [ ] **Held calls are invisible.** A call held while disconnected has no bound and the page shows
  only the connection banner. Done: the page can tell that an intent is pending (or a deadline fails
  it with a typed error the page shows), without changing what the domain sees.
- [ ] **Socket streams buffer for a stalled client.** `Representations` and `History` over the
  websocket subscribe to an unbounded `PubSub`; a client that stops acking keeps the server
  queueing. The HTTP route and the HTML stream use a latest-wins buffer. Done: the socket handlers
  bound what a stalled client costs, and the path tests still see every representation they wait for.
- [ ] **The worker page cannot see a dead worker.** `RpcClient.layerProtocolWorker` never reports a
  disconnect, so the banner reads `connected` while a failing worker is respawned every second and
  calls hang or die. Done: the worker page's `Connection` follows the worker's real state.

### Identity

- [ ] **A server-owned page does not know its bidder.** The wallet follows only an explicit
  `?bidder=` on pages whose actions run on the server, because no RPC tells a session its identity.
  Done: a read-only `Whoami` (or equivalent) RPC behind the authentication middleware, and the
  wallet follows the session's bidder.

### Persistence and synchronisation

- [ ] **The event log lives in the host's memory.** A host restart starts an empty log that
  surviving joiners do not detect, so every instance must restart together. Done: the log survives a
  host restart (persistent `Storage`) or joiners detect a new log and stop.
- [ ] **Sync and persistence exclude each other.** `MUFW_SYNC` refuses `MUFW_STORE`; a joiner
  catches up by replaying the whole log. Done: the persisted model stores its log sequence and a
  joiner starts from it, replaying only the tail.
- [ ] **One instance owns automatic actions by configuration.** If the instance with
  `MUFW_AUTO_ACTIONS=on` stops, nobody ticks. Done: a failover rule, tested with two instances.
- [ ] **Durability stops at the process.** The example's file store writes a temporary file and
  renames it without `fsync`, so a power loss can lose the last write. Done: the store syncs the
  file and its directory before reporting the write, with the guarantee stated in sam-loop.md.

### History

- [ ] **`replayInto` re-runs `nap`.** The ports offer no present without `nap`, so replaying into a
  loop whose automatic actions are on applies their recorded proposals twice. Done: a replay path
  that applies recorded proposals without starting automatic actions, or `replayInto` refuses a
  loop that runs them.

### Tooling

- [ ] **No build or publish.** Packages export TypeScript sources. Done when a consumer outside the
  workspace needs them: a build to `dist` and `exports` pointing at it.
- [ ] **`check:bundle` sees only `auctionLocal.ts`.** A page that calls `layerModelLocal(Auction, …)`
  directly, outside `src/client/placements/auctionLocal.ts`, is not detected. Done: a source or lint
  check that the auction's local halves are built only there.
- [ ] **One served definition.** The server serves only the auction; a second definition (its own
  `RpcServer.layer` and websocket path) is described but not exercised. Done: a second served
  definition with a path test against a live server.
- [ ] **Islands share the HTTP/1.1 connection cap.** Each demo tab holds a socket, an HTTP stream
  and a streamed iframe, so a browser's seventh tab on the same origin shows blank islands. Done:
  the server speaks HTTP/2, or islands share one connection.
