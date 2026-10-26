# Placement

Living document. Source of truth: `packages/core/src/Ports.ts`, `Layers.ts`, `Forward.ts`, `Persistence.ts`, `Sync.ts`, `SyncHead.ts`, `SyncSnapshot.ts`,
`SyncStorage.ts`, `SyncLease.ts`, `SyncPersistence.ts`, `packages/rpc/src/index.ts`, `examples/auction/src/client/`, `examples/auction/src/server.ts` and the route modules beside it.

Placement is a deployment decision. Each deployment has its own composition root, which chooses
layers; nothing is switched at runtime except on the demo page.

## Ports

`makePorts<D, R>(def)` returns five service keys, identified as `${def.name}/<Port>`. `R` is the
per-request services of the deployment (default `never`, see [Identity](#identity)):

| Port | Shape | Used by |
|---|---|---|
| `IntentPort` | `dispatch(intent): Effect<void, DispatchRefused, R>` | the view, `intentDriver`: where user intents enter the loop |
| `IntentBus` | `dispatch(intent): Effect<void, never, R>`, `dispatchAuto`, `intents: Stream<IntentEnvelope<_, R>>`, `runAuto(action)`, `interruptAuto` | the local loop: the queue in front of `ActionsDrain`, and the owner of automatic action fibers that `travelTo` interrupts |
| `ActionRunner` | `run(intent): Effect<proposal, ActionFailure, R>` | `ActionsDrain` |
| `ModelPort` | `present(proposal)`, `representations: Stream` (current value first) | `ActionsDrain`, the view, `presentDriver` |
| `HistoryPort` | `records: Stream<StepRecord>` (retained first, then live), `travelTo(seq)` (`NoSuchStep` for an evicted seq), `replay(proposals)` (applies them in order without `nap`) | devtools, test runner, `replayInto` |

`IntentPort` is separate from `IntentBus` because a page whose server runs the actions has no
local queue: its intents go straight to the server.

`DispatchRefused` (`@mufw/core`, a `Schema.TaggedError` with `intentTag` and `message`) is the
typed failure of a dispatch: the side that runs the actions did not accept the caller. It is not a
business outcome (those are proposals) and not a lost transport (that is a defect). The local bus
never fails; the remote port fails with it.

## Layers

| Layer | Provides | Requires |
|---|---|---|
| `layerIntentBus` | `IntentBus`, `IntentPort` (local) | — |
| `layerModelLocal(def, ports, options?)` | `ModelPort`, `HistoryPort` (one state object); `options.initial` replaces `def.initial` as seq 0 | `IntentBus` |
| `layerActionRunnerLocal` | `ActionRunner` | the actions' services except the ports' `R`, which `run`'s caller supplies |
| `layerActionsDrain` | — (background fiber) | `IntentBus`, `ActionRunner`, `ModelPort`; when an `AutoActionsGate` is provided, asks it for an epoch (`admit`) as it takes each automatic intent, drops the intent when there is none, and presents the action's proposal with `AutoEpoch` set to the epoch it got |
| `layerLoopLocal(def, ports, options?)` | all five ports, drain running; takes the options of `layerModelLocal` | the actions' services except the ports' `R` |
| `layerLoopWith(def, ports, { model, runner })` | the intent bus and the actions drain around a model layer (provides `ModelPort`, may require `IntentBus`) and a runner layer (provides `ActionRunner`), plus everything those provide; each side is local or remote as its layer says, and `browserOnly`, `serverModel` and `serverActions` in `src/client/placements/` each call it once; core imports no adapter | what `model` and `runner` require |
| `layerPersistModel(def, ports, key?)` | — (background fiber) | `HistoryPort`, `KeyValueStore` |
| `layerLoopPersisted(def, ports, key?)` | what `layerLoopLocal` provides, started from the stored model | the actions' services except the ports' `R`, `KeyValueStore` |
| `layerLoopSynced(def, ports, options?)` | what `layerLoopLocal` provides, and `AutoActionsGate`; `ModelPort.present` appends to the `SyncLog` and returns once the log's entry is applied; the instance that holds the log's lease runs the automatic actions, and their proposals are written as `AutoProposal { epoch, proposal }`, which every instance skips unless `epoch` is the lease's at that entry; `options`: `resume`, `checkpoints`, `stopped`, `lease`, `cut` (the host's cut, see [Server](#server)) | the actions' services except the ports' `R`, `SyncLog` |
| `layerLoopSyncedPersisted(def, ports, options?)` | what `layerLoopSynced` provides, resumed from the stored checkpoint (log id, sequence, model, lease) and storing one after each applied entry; `options`: `key`, `stopped`, `lease`, `cut` | the actions' services except the ports' `R`, `SyncLog`, `KeyValueStore` |
| `layerSyncLogStorage(def)` / `layerSyncLogRemote(def)` / `layerSyncLogClient(def)` | `SyncLog` (the host's storage in-process, which can cut when `SyncStorageCut` is provided / over a client protocol that carries `SyncRpcs` / over `SyncClient`); a subscription says which log it is and where it ends | `Storage`, `SyncHead` / `RpcClient.Protocol` / `SyncClient` |
| `layerSyncServer(def)` / `layerSyncAuthorization` | the `SyncRpcs` handlers (the event-log RPCs and `Sync.Head`) over the `Storage` and `SyncHead` in context / `EventLogServerAuthorization`: read by anyone, write only `Proposal`, `AutoProposal`, `Joined` and `Lease` entries | `Storage`, `SyncHead`, `EventLogServerAuthorization` / — |
| `layerSyncStorage(def)` | the event-log `Storage` over a `KeyValueStore`: the log and its id survive a restart; `SyncHead`; `SyncStorageCut`, which replaces the log's first entries by a `Snapshot` | `KeyValueStore` |
| `layerSyncStorageMemory(def)` | the `Storage` in memory, gone with the process, and its `SyncHead`; no `SyncStorageCut`, so it cannot be cut | — |
| `layerForward(from, to, forward)` | — (background fiber) | `from.ModelPort`, `to.IntentPort` (and `to`'s `R`) |
| `Rpc.layerIntentPortRemote` / `layerModelRemote` / `layerHistoryRemote` / `layerActionRunnerRemote` | the port | `Rpc.Client` |
| `Rpc.layerClient` | `Rpc.Client`, whose unary calls are counted by the hold layer when it is the protocol | `RpcClient.Protocol` (transport chosen by the app), the client half of the authentication middleware |
| `Rpc.layerClientTest` | `Rpc.Client` | `Rpc.layerHandlers`, the authentication middleware on both sides (in-process, no serialization) |
| `Rpc.layerHoldRequestsWhileDisconnected` | `RpcClient.Protocol` that holds a request made while the socket is down until the next connection, whichever client made it, and `HeldRequests`, the count of unary calls of `Rpc.layerClient` waiting | an inner socket `RpcClient.Protocol` that redials without end (see [Deployments](#deployments)) |
| `Rpc.layerHandlers` | the RPC handlers | `IntentPort`, `ModelPort`, `HistoryPort`, `ActionRunner`, and the ports' `R` except what the middleware provides |

`layerLoopSynced`, `layerLoopSyncedPersisted`, the `layerSync*` layers, `SyncRpcs`, `SyncClient`, `SyncHead` and the lease and checkpoint
schemas are imported from `@mufw/core/sync`; every other `@mufw/core` layer above comes from the entry.

## Wire contract

`makeRpc(def, ports, authentication).group`:

| RPC | Payload | Success | Error | Trust |
|---|---|---|---|---|
| `Submit` | intent | void | `DispatchRefused`, `Unauthenticated` | the server runs the action, as the session's identity, and its own model |
| `Present` | proposal | void | — | the server applies whatever the client computed |
| `Dispatch` | intent | proposal | `ActionFailure`, `Unauthenticated` | the server runs one action, as the session's identity, for a client-side model |
| `Representations` | — | stream of representation | — | read-only |
| `History` | — | stream of `StepRecord` | — | read-only |
| `TravelTo` | `{ seq: Int }` | void | `NoSuchStep` | rewrites the server's model; development only |
| `Replay` | `{ proposals: [proposal] }` | void | — | the server applies the proposals in order, one `step` record each, without running its `nap`; development only, as trusting as `Present` |

`Submit` and `Dispatch` run actions, so `makeRpc(def, ports, authentication)` attaches the
`authentication` middleware (`RpcMiddleware`, error `Unauthenticated`) to them and to no other RPC.
`Present`, `TravelTo` and `Replay` stay unauthenticated: they are served only to clients the deployment
already trusts with the whole model, and `Representations` and `History` only read.

`Rpc.exposing(tags)` is the group a server serves: an RPC not listed is not routed, so calling it
fails on the client and changes nothing on the server.

The example adds one RPC of its own beside that contract: `Whoami` (`src/whoami.ts`), with no payload,
the session's `Bidder` as success and `Unauthenticated` as error, behind the same `Authentication`
middleware. Its handler returns the `CurrentBidder` the middleware provided, so the answer is what
the actions would see. It is not in `SamRpcs`: identity (`CurrentBidder`, `Sessions`) is the example's
domain, and `@mufw/rpc` stays generic over the definition. It is not in `rpcTags` either, so
`MUFW_RPCS` neither lists nor removes it: `serving(rpcs)` (`src/serverPorts.ts`) is `ServerRpc.exposing(rpcs)`
plus `WhoamiRpcs`, and `layerServerHandlers` its handlers. The server always serves it because it
is read-only, runs no action and tells a caller only the identity its own session already has. The client side is the `Whoami` port (`src/domain/Whoami.ts`,
`{ bidder: Effect<Bidder, Unauthenticated> }`) with `layerWhoamiRemote` over the same protocol as
`Rpc.layerClient` (a second `RpcClient.make` on one protocol has its own client id), decoding the
response with the `Bidder` schema; a lost transport is a defect, as in the other remote ports. The
worker host does not serve it: the `worker` page names its bidder itself.

### Stalled clients

A served stream is pulled one chunk at a time and the server waits for the client's ack before the
next (the HTTP protocol has no acks, so there the write itself blocks), so a client that stops reading
stops the handler. What the loop publishes meanwhile is bounded for both streams, in the layer that
owns the data, so the websocket, the worker and the HTTP route all get it from `Rpc.layerHandlers`
and `layerModelLocal`:

- **`Representations` keeps the newest.** The handler reads `representations` through a sliding
  buffer of `RepresentationBacklog` (`@mufw/rpc`, a `Context.Reference`, default 64). A client that
  falls further behind than that skips to the newest snapshots, which loses nothing: each one is the
  whole view. A burst that fits in the buffer arrives complete, so a waiter that needs an
  intermediate representation (`reached` in `@mufw/test`) sees it unless its client stops reading for
  more than the buffer holds. The HTTP route sets it to 1 at its composition root, because a page
  there only paints the latest.
- **`History` keeps nothing for a stalled client.** Records are not snapshots, so none may be
  skipped. `layerModelLocal` publishes them through a sliding window of `HistoryBacklog` records
  (`@mufw/core`, default 64) shared by every subscriber, so a subscriber that stops reading cannot
  make the loop hold more than the window. When it resumes and finds a gap, the stream reads what it
  missed from the retained records (bounded by `HistoryLimit`, default 1000, and by
  `HistoryRetainedSize`), in seq order and without
  duplicates: no resubscription is involved, and the client's `undelivered` filter only matters for
  a lost connection. A subscriber that lags more than the retained records skips the evicted ones,
  as a subscriber that connects late never sees them; its seqs show the gap.

`packages/rpc/test/Backlog.test.ts` stalls a remote client on its first item and checks both streams;
`packages/core/test/ModelLocal.test.ts` checks what a stalled `records` subscriber is given.

### HTTP

A client that only reads can use HTTP instead of a socket: `Representations` is a streaming `POST` whose
response body is NDJSON (`RpcServer.layerProtocolHttp` / `RpcClient.layerProtocolHttp` with
`RpcSerialization.layerNdjson`), so each representation reaches the client as the server produces it
and a cut stream is requested again. `RpcClientError` carries `HttpError` for it: `TransportError`
(the request never reached the server) and `DecodeError` (the response body was cut) are a lost
connection, like a socket error, and `layerModelRemote`'s stream resubscribes after the same one
second; a status error or a malformed body stays a defect. Calls that run actions are never
retried (`layerHoldRequestsWhileDisconnected` is for sockets and still reacts to socket errors
alone), and the HTTP client has no `Connection` state.

## Identity

An intent never says who acts: `PlaceBid` carries an amount, and its action reads the bidder from
`CurrentBidder`, a port declared in `src/domain/CurrentBidder.ts` and required in the action's `R`.
Who provides it depends on where the action runs:

| Actions run | Provider of `CurrentBidder` | Source of the identity |
|---|---|---|
| on the server (`Submit`, `Dispatch`) | the `Authentication` middleware, per request | the session token the client sends in the `x-session-token` header, looked up in `Sessions` (`src/adapters/sessionsTable.ts`) |
| in the browser | `layerCurrentBidderFixed(bidder)` in `auctionActionRunnerLocal`, for the bidder the page's entry passes | the page's `?bidder=`; the browser is already trusted with the model there (the server applies any proposal), so it vouches for itself |
| in a worker (`Submit`) | `layerAuthenticationFixed(bidder)`, the worker's `Authentication`, per request | the page's `?bidder=`, sent once as the worker's initial message and decoded at the worker's composition root; the page that started the worker is its only client |

- The middleware (`src/authentication.ts` declares it, `src/adapters/authenticationServer.ts` implements
  it) decodes the header into a `SessionToken`, asks `Sessions` for the bidder and provides
  `CurrentBidder` to the handler; a missing or unknown token fails with `Unauthenticated`
  (`@mufw/rpc`, a `Schema.TaggedError`) before any action runs. The server's session table is an
  adapter in its own module, so no page ships the tokens.
- The token travels in a request header: a browser websocket cannot set headers on the upgrade,
  but each RPC request has its own, so the client middleware (`layerAuthenticationClient(token)`)
  adds it per request. The middleware is `requiredForClient`, so a client cannot be built without
  choosing a session or `layerAuthenticationAnonymous` (what a page that only calls `Present` and
  the read RPCs uses).
- The page learns the identity the same way it is decided. `Whoami` is the page's port for it
  (`{ bidder: Effect<Bidder, Unauthenticated> }`): the `serverOwned` and `serverActions` placements
  provide it with `layerWhoamiRemote`, which sends the same session as the rest of the client's
  requests and so gets the bidder the server would run an action as; `browserOnly`, `serverModel` and
  `workerPorts` provide `layerWhoamiFixed(bidder)`, the page's own `?bidder=`, for the same reason
  `CurrentBidder` is fixed there. Nothing flows from a page's `Whoami` to the server: the server
  derives every identity it uses from the session alone.
- The identity has to cross the queue of a server-owned loop. `IntentBus.dispatch` captures the
  services of the dispatching fiber in the `IntentEnvelope`, and `ActionsDrain` runs a user
  intent's action with them; automatic intents carry none, so an action that `nap` triggers must
  not need a per-request service.
- Per-request services are in the types. A server builds its ports with
  `makePorts<typeof Auction, CurrentBidder>(Auction)` (`src/serverPorts.ts`): `R` is then in the `R`
  of `IntentBus.dispatch`, `IntentPort.dispatch` and `ActionRunner.run`, and
  `layerLoopLocal(Auction, ServerPorts)` does not require `CurrentBidder` when it is built, since a
  request supplies it. A dispatcher that does not provide it does not compile: the effect keeps
  `CurrentBidder` in its `R`, which `Effect.runPromise`, `it.effect` or a layer cannot accept
  (`packages/core/test/RequestServices.test.ts`, `examples/auction/test/Identity.test.ts`).
  `Rpc.layerHandlers` of `makeRpc(Auction, ServerPorts, Authentication)` carries the same `R` minus
  what the middleware `provides`, so the handlers are the dispatchers that need nothing more. A
  page's ports keep `R = never`; `layerMount` accepts only those.
- Over `Submit` the page learns that its session was refused: the remote `IntentPort` maps the
  middleware's `Unauthenticated` to `DispatchRefused` and dies only on `RpcClientError` (a lost
  transport). `Dispatch` maps `Unauthenticated` to an `ActionFailure` the drain logs.
- `layerMount` takes `onRefused`, the effect that receives a `DispatchRefused` its dispatch failed
  with. The auction page passes `Refusals.report` (`src/client/refusals.ts`), a `SubscriptionRef` of
  the latest refusal apart from the SAM representation, and `layerRefusalNotice`
  (`src/client/refusalNotice.ts`) renders it above the view like the connection banner and clears
  it after a few seconds. The domain and the representation do not know about it.

## Deployments

Each page of the example is one deployment. Its entry point
(`src/client/<page>.ts`) calls one placement from `src/client/placements/` and `runPage` (but see
the `devtools` page below), which
mounts the view over it plus the devtools layer the entry passes: only the demo and `worker` pass the
time-travel panel, because only they can rely on `TravelTo` being served. Every placement `runPage`
takes also provides the page's `Whoami` (see [Identity](#identity)); `runPage` mounts the wallet island over it (see [Islands](#islands)).

| Page | Model | Actions | Placement layers | RPCs needed |
|---|---|---|---|---|
| `browser-only` | browser | browser | bus, drain, local model and runner (`auctionLocal.ts`: permissive credit check, `?bidder=` identity), `layerWhoamiFixed` | none |
| `server-owned` | server | server | remote `IntentPort`, `ModelPort`, `HistoryPort`, sending `?session=`; remote `Whoami` over the same connection | `Submit`, `Representations`, `History` (`Whoami` is always served) |
| `server-model` | server | browser | local bus, drain, runner (permissive credit check, `?bidder=` identity) + remote model and history, anonymous; `layerWhoamiFixed` | `Present`, `Representations`, `History` |
| `server-actions` | browser | server | local bus, drain, model + remote runner sending `?session=`; remote `Whoami` over the same connection | `Dispatch` (`Whoami` is always served) |
| `devtools` | none | none | remote `HistoryPort` only (`historyOnly.ts`), anonymous; mounts `layerHistoryList` and the connection banner, no view, wallet or `runPage` | `History` |
| `worker` | worker | worker | remote `IntentPort`, `ModelPort`, `HistoryPort` over `RpcClient.layerProtocolWorker`, anonymous, `?bidder=` sent as the worker's initial message (`placements/worker.ts`) and also the page's `layerWhoamiFixed`; the worker serves them from `layerLoopLocal` (`placements/workerHost.ts`, `auctionLoopLocal`) | `Submit`, `Representations`, `History`, `TravelTo` |
| `index` (demo) | from `?placement=` | | any of the four, chosen at runtime; plus the ticker island, over HTTP (`httpReadOnly.ts`) or the websocket (`socketReadOnly.ts`) from `?ticker=`, and the HTML stream in an `<iframe>` | all, and `Representations` over HTTP |

Where each fixed page runs its auction is stated once, in the `placements` table of
`src/deployments.ts` (layer-free: `{ model, actions }`, each `client` or `server`, per page but the
demo, whose placement comes from its query string). Three readers derive from it and nothing copies
it: the footer labels (`pageLabels` in `src/client/labels.ts`, through `formatPlacement`), the
`check:bundle` expectations for the four pages (a local half is present exactly for a `client`
side), and the server-rendered first paint (`embedsModel` in `src/ssr.ts`: a page carries the model
snapshot exactly when its model side is `client`). The composition in `src/client/placements/` is
written to match the table; the bundle check is what fails when it does not.

- Each deployment is built on its own: `vite build --mode <deployment>` takes that page as its only
  entry and writes `dist/<deployment>`, so a server-owned bundle contains no local model or action
  runner of the auction (`demo` is the one build that holds all four placements). Every page but
  `devtools` runs the wallet's local loop, so `layerModelLocal` and `layerActionRunnerLocal` of
  `@mufw/core` are in those bundles and say nothing about the auction. `pnpm build:client` builds
  every deployment and then runs `check:bundle`, which reads which exports each build kept (names
  that survive minification): `walletBrowserOnly` and `makeAuctionView` in every checked deployment but `devtools` (`demo` holds all four placements and is not checked), as the
  control that the names are not stale, and the exports of `src/client/placements/auctionLocal.ts`
  (`auctionModelLocal`, `auctionActionRunnerLocal`), the one place a page builds the auction's local
  halves. It fails when a deployment ships a half of the auction it delegates, or lacks one it runs;
  `devtools` must ship `layerHistoryList` and none of the above nor `layerPanel`; `worker` must ship
  none of the auction's local halves in its page bundle (`auctionLoopLocal`, the worker's, included),
  emit the worker as a file, and, in the module graph built from `src/client/auctionWorker.ts` (a
  page's build emits a worker as an opaque minified file), ship `auctionLoopLocal` and neither the
  wallet nor the view). A page that imports only the local loop (`scripts/bench/pages/counter-mufw.ts`,
  built in memory from its entry) must carry no module of `effect/eventlog` or `effect/encoding` that
  the plain `Schema` floor does not (`Schema` itself imports `encoding/Base64`): the synchronisation
  layers are exported by `@mufw/core/sync`, not by the `@mufw/core` entry, so a page that does not
  import them cannot bundle them. The page must also carry `Layers.ts` of `@mufw/core`, the control
  that the check looks at a local loop and not at an empty bundle.
  Before it builds, `check:bundle` parses every module under `src/client` (TypeScript compiler API,
  `scripts/auctionLocalHalves.ts`) and fails on a call to `layerModelLocal`, `layerActionRunnerLocal`
  or `layerLoopLocal` whose definition is the auction's (`src/auction/Auction.ts`) outside
  `placements/auctionLocal.ts`, the only allowed module: the worker host and every placement import
  that module's exports rather than call the builders. Imports of the builders and of the definition
  may be aliased or namespaced and the definition may sit in a `const`; the wallet's loop, built with
  the wallet's definition, and the server's own halves are not in scope. The same scan runs in
  `pnpm test` (`test/auctionLocalHalves.test.ts`).
- The `devtools` page is not an auction page: `src/client/devtools.ts` composes the remote history
  (`historyOnly.ts`, which sends no session) with the panel and the connection banner and does not
  call `runPage`. It is read only on purpose: the server it targets serves `History`, not `TravelTo`.
- The `worker` page runs the auction's model and actions in a dedicated web worker, with no domain
  change and no server. The worker's composition root is `src/client/auctionWorker.ts` (a process
  entry point: it runs `workerHost` with `BrowserRuntime.runMain`); the page starts it with
  `new Worker(new URL("../auctionWorker.ts", import.meta.url), { type: "module" })` in
  `placements/worker.ts`, the form the bundler recognises, and `worker.format` is `es` in
  `vite.config.ts`. `workerHost` is `RpcServer.layerProtocolWorkerRunner` serving
  `ServerRpc.exposing(["Submit", "Representations", "History", "TravelTo"])` over
  `layerLoopLocal(Auction, ServerPorts)` with the permissive credit check; `Present` and `Dispatch`
  are not routed, since the page needs neither. Worker protocols use structured clone and need no
  `RpcSerialization`. The worker cannot read the page's URL, so the page's `?bidder=` travels as the
  protocol's initial message (`RpcWorker.layerInitialMessage` on the page, `RpcWorker.initialMessage`
  in the worker): `WorkerInit` (`src/client/workerInit.ts`) is decoded once, at the worker's
  composition root, before anything is served, and a message that does not decode fails the worker
  at startup. Identity is a fixed one, by the same argument as `browser-only`: the page that started
  the worker is its only client and is already trusted with its own state. The worker's
  `Authentication` (`adapters/authenticationFixed.ts`) provides that bidder to every request; the
  page sends no credential (`layerAuthenticationAnonymous`). Only the worker's entry imports that
  adapter; the network server keeps `layerAuthenticationServer`, so nothing a server trusts changes.
  The pool is `{ size: 1, concurrency: Number.MAX_SAFE_INTEGER }`: a streaming request keeps its
  lease on the worker until it ends, so the default of one concurrent request would let the first
  `Representations` stream starve every other call. `Connection` follows the worker, not the
  protocol: `makeProtocolWorker` calls `RpcClient.ConnectionHooks.onConnect` once, right after the
  pool hands out its handle and before the worker has been created or has said anything, and never
  `onDisconnect`, and it forks `backing.run` with a retry every second, so the layer builds whether
  or not the worker comes up. The page therefore wraps the `WorkerPlatform` (`layerWorkerConnection`
  in `src/client/connection.ts`, merged into the placement's output with `Layer.provideMerge`) and
  reads each worker's `run`: `connecting` until the first worker says it is ready (the `onSpawn`
  hook, after the protocol has sent the initial message), `connected` from then on, `disconnected`
  when `run` ends. `run` ends when the worker raises an `error` event (`WorkerReceiveError`) or when
  spawning it throws; the protocol then retries after a second, a respawned worker reads
  `connected` once it is ready, and one that fails again stays `disconnected` instead of flickering
  through `connecting`. A `messageerror` on the page's side of the port is not listened to by
  `BrowserWorker`, and a worker that stops without an error event shows no signal. The worker
  reports its own failure: `auctionWorker.ts` runs with a teardown that re-raises a failed main
  effect (a first message that does not decode, a server layer that dies) with `reportError` and
  closes, since a failed `runMain` only logs and leaves a worker that already said it was ready. The
  calls themselves are not held, as the socket's are: while a worker is down they hang until it is
  ready (sends are buffered) or die with `RpcClientError` on its error event. `WorkerError` is in
  the placement's type only because `layerProtocolWorker`'s signature carries it; nothing in 4.0.5
  produces it when the layer builds. The wallet island stays browser-only on the main thread, fed
  from the worker's representations.
- `transport(def, client)` is called once per placement and remote definition; the returned layer
  value is built once, so that definition's remote ports share one connection, and `browser-only`
  never opens one. It builds a protocol of its own (`Layer.fresh`), so two remote definitions never
  share a socket. The server's websocket origin is a build-time setting, `VITE_SERVER_URL` (typed in
  `src/client/env.d.ts`, defaulted in `.env`, overridable per deployment in `.env.<deployment>`),
  decoded when the layer is built as a `ws://`/`wss://` origin without a path; the socket URL is
  that origin plus `samPath(def)`, `/sam/<name>`.
- A lost websocket is redialled by `layerProtocolSocket` (`src/client/connection.ts`) with
  `reconnectSchedule` (500 ms growing by 1.5×, capped at 5 s, no limit) and
  `retryTransientErrors`, so a dial that cannot open leaves calls pending instead of failing them.
  The remote `ModelPort.representations` and `HistoryPort.records` resubscribe after a socket
  error (`@mufw/rpc`): the first representation after the reconnection is the server's current
  one, and `records` drops what it already delivered, or starts over when the server restarted
  (a new `init` record). A call (`present`, `dispatch`, `run`, `travelTo`, `replay`) made while the socket
  is down is held and sent once, after the reconnection, in the order the calls were issued:
  `layerHoldRequestsWhileDisconnected` (`@mufw/rpc`) wraps the client protocol and retries `send`
  every 250 ms for as long as the protocol still carries the error of the dropped socket. Every
  request goes through one queue and one writer fiber per protocol, retries included, so a later
  call, held or live, is written after an earlier held one (a `Semaphore` would not guarantee it:
  it wakes its waiters from a scheduled task, and a call issued before that task runs overtakes the
  waiter). A call interrupted while it waits in the queue is never written, and one still waiting when the protocol's scope closes (or made after) is interrupted, as `RpcClient` does for its own calls. The writer does not
  wait for the response, so round trips stay concurrent. Interrupt, ack and end messages do not
  take the queue. The layer requires an inner `layerProtocolSocket` with `retryTransientErrors: true` and a retry
  policy that never ends: without the first a failed redial is broadcast as a client error and
  fails the held calls, and when a bounded policy runs out the protocol stops redialling while
  the held calls keep retrying every 250 ms. The socket protocol refuses a `send`
  only before writing anything, so a refusal proves the server has not received the request and
  sending it again cannot apply a bid twice. A call already written when the socket drops is not
  sent again, because the server may have run it and `Submit`, `Present` and `Dispatch` are not
  idempotent: it fails with the socket error, which the remote ports turn into a defect (no port
  changes its error type). The protocol broadcasts the error of a dropped socket to every call the
  client has in flight, a request still waiting in the queue included, and the client cannot fail
  some of them and not others. The layer therefore keeps that broadcast from the client and fails
  each request it had written itself: the `send` of a request returns when its response has arrived,
  not when it is written, and fails with the socket error when the connection is lost first. A request
  still queued stays queued and is written after the next connection, however many times the
  connection drops, for any client built over the layer: `Rpc.layerClient`, or the event-log client
  of a synced instance, which `effect/eventlog` builds with `RpcClient.make`. The encoded request
  does not say whether its RPC streams, so `Rpc.layerClient` runs each unary call with the
  `CountedCall` reference set, which the layer reads in the fiber that sends the request: only those
  calls are counted in `HeldRequests`; a client built any other way is not counted. A call stays pending, with no timeout, for as long as the
  server is unreachable; interrupting it abandons it. A deadline would turn a held call into a typed
  failure that the ports must carry or die with, which changes what the domain sees; so the page is
  told instead (below).
- Transport state is data outside the SAM representation: `Connection` is a `Context.Reference`
  holding a `Stream<"connecting" | "connected" | "disconnected">`, fed by the protocol's
  `ConnectionHooks` for a socket and by the worker platform for a worker. `transport()` and
  `workerPorts` provide it and the placements merge it into their output with
  `Layer.provideMerge`; `runPage` mounts `layerConnectionBanner` over it. A page with no remote
  port provides nothing, reads the default (always `connected`) and shows no banner. The calls held
  while disconnected are data of the same kind: `HeldRequests` (`@mufw/rpc`) is a `Context.Reference`
  holding a `Stream<number>`, the count of unary calls (not stream subscriptions, which carry no
  intent and resubscribe by themselves) that have waited more than 200 ms to be written, whether the
  socket dropped, a request ahead of them (a stream's, say) is waiting, or the first connection has not
  opened yet. The grace keeps a call that a live socket writes at once from flashing the notice, and
  the count does not wait for a refused write, which only the request at the head of the queue is
  made to attempt. The count is provided by `layerHoldRequestsWhileDisconnected` and so by
  `transport()` through
  `layerProtocol`; `runPage` mounts `layerHeldNoticeWith` over it (`src/client/heldNotice.ts`, "n
  actions will be sent once reconnected", hidden at 0). The domain and the representation never see
  it: the call waits as it always did. A page with no socket (browser only, worker, HTTP) reads the
  default, 0, and shows no notice.
- Domain services follow the same rule: `src/domain/CreditCheck.ts` is only the port, the server's
  table is `src/adapters/creditCheckTable.ts` and the browser's stand-in is
  `src/adapters/creditCheckPermissive.ts`, so no page ships the server's limits. `Sessions` and
  `CurrentBidder` are ports in `src/domain/` too, with `sessionsTable.ts` (server) and
  `currentBidderFixed.ts` (pages that run their own actions) as adapters.

| Placement | Round trips per user intent | Where `nap` runs |
|---|---|---|
| browser only | 0 | browser |
| server owned | 1 (`Submit`) | server; the browser only streams representations |
| server model | 1 (`Present`) | server |
| server actions | 1 (`Dispatch`) | browser; each automatic `Tick` is a `Dispatch` |
| worker | 1 (`Submit`, a message to the worker, no network) | worker; each automatic `Tick` is local to it |

A rule that must hold (the credit limit) belongs to an action on the server, and the server must
not serve `Present` to untrusted clients: with `Present` served, any client can apply any proposal.

## Islands

Several definitions can share a page, each with its own loop, root and placement; `makePorts` keys
their services by `def.name`, so the names must differ. `layerForward(from, to, forward)`
(`@mufw/core`, `Forward.ts`) connects them: a background fiber over `from.ModelPort.representations`
(current value first) applies `forward(previous, current)`, which is pure and sees the previous
representation (`none` for the first), and dispatches each `Some` intent through `to.IntentPort`.
Deduplicating is `forward`'s business: it returns `none` when nothing relevant changed. A
`DispatchRefused` is logged at warning level and forwarding continues; a defect in `forward` or in
the dispatch (a lost transport, for a remote `to`) is logged at error level and forwarding continues
too. Both sides are ports, so each may be local or remote.

The example's second island is the wallet (`src/wallet/Wallet.ts`): model `{ credit, reserved }`,
control states `funded` | `exhausted` (no credit left), intents `Reserve { amount }` | `Release`,
proposals `Reserved` | `Released` | `Refused`. A reservation replaces the previous one (the wallet
holds what backs the leading bid, not a sum); `Reserve` above the credit is `Refused` by the action
and leaves nothing held. Its acceptors are pure and tested with literal models (`test/wallet/Wallet.rules.test.ts`); the path tests use
`test/wallet/Wallet.pathModel.ts`. The wallet is mounted browser-only on every auction page (`walletBrowserOnly`, a
`layerLoopLocal`) and fed by `holdForBids(bidder)` (`src/wallet/Wallet.feed.ts`): the leading bid
when it is the bidder's becomes `Reserve`, anything else `Release`, and only a change of that hold
is forwarded (a wallet starts released, so a first representation without a bid asks nothing).

The wallet's owner is the bidder the page's `Whoami` names (`walletOwner`, `src/client/walletOwner.ts`:
an `Option<Bidder>`, `None` when `Whoami` fails with `Unauthenticated`), asked once when the wallet
island is built, so the wallet's mount waits for the answer (the rest of the page does not) and a
call made while the socket is down is held like any other. `layerWalletFeed(owner)` feeds the wallet
from the auction for a `Some`. Where the actions run in the browser or in the worker (`browser-only`,
`server-model`, `worker`) `Whoami` is the page's `?bidder=`, default `alice`. Where they run on the
server (`server-owned`, `server-actions`, the demo with `actions:server`) it is the server's answer for
the page's `?session=`, so the wallet follows the session's bidder and a `?bidder=` there is ignored. A
session the server refuses gives `None`: the wallet is mounted but not fed, and its view says "follows
no bidder". The wallet is the visitor's own and enforces nothing the server relies on. It is tested
with the server side in-process (`test/WalletOwner.test.ts`).

Nothing about the server changes for an island: it serves each definition it hosts on its own path
(see [Server](#server)).

The ticker is the example's read-only island: the auction's control state and highest bid
(`src/auction/Ticker.view.ts`), mounted on the demo page beside the auction in its own root
(`<div id="ticker">`) by `runTicker` (`src/client/ticker.ts`). Where it reads from is data that the
demo's composition root passes in (`TickerTransport`: a placement and the line the view shows as its
source), picked by `?ticker=http|socket` in `src/client/demo.ts`; a missing or unknown value is the
default, `http`. Each transport is its own placement, apart from the page's, whatever the page's
placement is: the remote `ModelPort` alone, over `RpcClient.layerProtocolHttp` + NDJSON +
`FetchHttpClient` (`httpReadOnly`, `src/client/placements/httpReadOnly.ts`) or over the websocket
(`socketReadOnly`, `src/client/placements/socketReadOnly.ts`). Its mount, `layerMountReadOnly`
(`@mufw/view-uhtml`), requires `ModelPort` and gives the view no `dispatch`, so it has no `IntentPort`
to hold and cannot act on the auction. It shows the server's auction, which is the page's own only for
`model:server`. The endpoint's address is `VITE_SERVER_URL`: for HTTP read as an HTTP origin (`ws://` is
`http://`, `wss://` is `https://`; `HttpServerOrigin` in `src/client/serverOrigin.ts`) plus
`samHttpPath(def)`, for the websocket as it is plus `samPath(def)`.

### Choosing a read-only island transport

Three ways follow the server's auction without acting on it: the remote `ModelPort` over the websocket,
the same port over HTTP (NDJSON), and the HTML stream (`GET /stream/<name>`, no client code). The
default for a read-only island that the page renders is **HTTP**; an island that can be a document of
its own is the HTML stream's.

```sh
pnpm --filter @mufw/example-auction compare:transports
```

`scripts/compare-transports.ts` starts a server of its own on a free port from 4700 to 4799 (the
auction fresh, `MUFW_AUTO_ACTIONS=off`, `Present` and `Representations` served), builds the two bundled
pages with `vite build` and serves them, and drives headless Chromium over the same auction for each
transport in turn. Both measures are taken in the page and mean the same for all three:

- first paint: from the navigation's start to the first time the DOM shows the auction, over cold loads;
- update latency: from the script's `ModelPort.present` to the first time the DOM shows that update,
  one update at a time (a bid by a bidder whose name marks it).

It prints the median and the 95th percentile of each, and the size of each page's client JavaScript.
`MUFW_COMPARE_LOADS`, `MUFW_COMPARE_UPDATES` and `MUFW_COMPARE_WARMUP` set the sample sizes. The page
and the server share a machine, so the network contributes nothing: the table compares what each
transport and renderer adds, and the figures are not those of a real link. Run it again after a change
to a transport, a view or the bundle; the numbers are not kept here because nothing would keep them
current.

What the comparison decides:

- **Update latency does not separate them.** The medians are within a fraction of a millisecond of each
  other, far below what a user perceives, and the order of the socket and HTTP changes from run to run.
- **First paint separates the HTML stream from the other two**, which are alike: the stream's first
  chunk is the document, while a bundled island waits for its JavaScript to load and start, then
  connects. That is a cost the HTML stream does not have, and it is the only one of the three that
  ships no client code.
- **HTTP is the default for an island the page renders, not the socket**, because on the measures they
  tie, and then the endpoint decides: `httpRoutes.ts` routes `Representations` and nothing else
  whatever `MUFW_RPCS` says, so a read-only island reads from an endpoint that cannot be asked to
  write; the websocket route serves whatever the deployment's `MUFW_RPCS` lists (`Present`, `Submit`,
  ...). Over HTTP the island needs no upgrade through a proxy and holds no `Connection` state to
  show.
- **The HTML stream is the choice when the island may be a document of its own** (an `<iframe>` or a
  link, as the demo's): display only, nothing of the page's styles, state or other islands in it, and
  the server renders the whole view, so an update carries markup rather than data. It cannot take part
  in the page's DOM, which is why the ticker, a view the page composes, is not on it.
- **What HTTP and the stream cost, and the socket does not:** each open island holds one response, and
  a browser limits the connections it opens to an origin over HTTP/1.1, so many islands on one origin
  want HTTP/2 (see [Connections and HTTP/2](#connections-and-http2)); a proxy that buffers responses holds chunks back (the stream sets `x-accel-buffering`
  and `no-store` against it, and the NDJSON route has the same exposure); and the endpoint is open to
  any origin, so it must stay read-only.

The socket stays selectable (`?ticker=socket`) so the demo can be compared by eye and a deployment can
pick it as data at its own composition root; nothing selects it by default.

## Server

`src/server.ts` is the server's composition root. Configuration is parsed with `Config`, so a bad
value stops the server at start with a typed error:

| Variable | Parsed as | Default |
|---|---|---|
| `MUFW_RPCS` | `Config.Array(Schema.Literals(rpcTags))` | `Submit,Representations,History` |
| `MUFW_AUTO_ACTIONS` | `Config.withDefault(Config.Literals(["on", "off"]), "on")`: `off` never runs automatic actions; with `MUFW_SYNC`, `on` takes part in the lease | `on` |
| `MUFW_STORE` | `Config.option(Config.NonEmptyString)`: a directory | unset: the model, and the host's log, live in memory |
| `MUFW_SSR` | `Config.option(Config.Literals(deployments))`: a built deployment (`demo`, `browser-only`, `server-owned`, `server-model`, `server-actions`) | unset: the server serves no page and no assets |
| `MUFW_PORT` | `Config.Port` | `3001` |
| `MUFW_TLS_CERT`, `MUFW_TLS_KEY` | `Config.option(Config.NonEmptyString)` each: paths of a PEM certificate chain and its private key; one without the other is a `TlsConfigError` | unset: plain HTTP/1.1 |
| `MUFW_SYNC` | `Config.option(Config.schema(SyncTarget))`: `host`, or the `ws://` or `wss://` URL of a host's `/eventlog` (its sync port) | unset: one instance |
| `MUFW_SYNC_PORT` | `Config.Port`: with `host`, the port of the event-log listener; must differ from `MUFW_PORT` (`SyncConfigError`) | `3101` |
| `MUFW_SYNC_HOST` | `Config.NonEmptyString`: with `host`, the interface the event-log listener binds | `127.0.0.1` |
| `MUFW_SYNC_CUT_EVERY` | `Config.schema` of an `Int` of at least 1: with `host` and `MUFW_STORE`, how many entries the host applies after the log's last cut before it cuts again; an instance that joins, or a host without a store, never cuts | `1000` |

Wiring: `RpcServer.layer(serving(rpcs))` (`ServerRpc.exposing(rpcs)` plus `Whoami`, always served) + `layerServerHandlers` + the loop from
`layerAuctionLoop(store)` (`src/persistence.ts`; with `layerCreditCheckTable` and `AutoActions`,
`CurrentBidder` left to the request) +
`layerAuthenticationServer` over `layerSessionsTable` + `RpcServer.layerProtocolWebsocket({ path: samPath(Auction) })`
(`/sam/auction`) + JSON serialization, served by `HttpRouter.serve` on the listener `layerListener` builds (`src/listener.ts`, a `NodeHttpServer`) at `MUFW_PORT`.
Each served definition gets its own path, `/sam/<def.name>`, so the RPC tags stay those of the wire
contract; `MUFW_RPCS` applies to every definition. Two are served, the auction and the wallet.

The wallet is the second definition (`src/walletServer.ts`): `RpcServer.layer(WalletRpc.exposing(rpcs))`
+ `WalletRpc.layerHandlers` + `RpcServer.layerProtocolWebsocket({ path: samPath(Wallet) })`
(`/sam/wallet`) + JSON serialization, over its own loop, `layerLoopLocal(Wallet, WalletPorts)`. Both
definitions' route layers are merged into the one `HttpRouter.serve` and their loops into the one
`Layer.provide` after it; nothing collides because every key is per definition: `makePorts` prefixes
its services by `def.name`, `makeRpc` names its client `<name>/rpc/Client`, and each `RpcServer.layer`
gets its handlers and protocol from its own `Layer.provide`. The wallet's actions read no
`CurrentBidder`, so no authentication stands in front of them. Its model is one instance of the
server's, shared by every client of `/sam/wallet`, in memory whatever `MUFW_STORE` and `MUFW_SYNC`
say, and no page reads it: the pages keep the wallet in their browser, which follows the auction
(`layerForward`).

Another `RpcServer.layer` serves `Rpc.exposing(["Representations"])` over HTTP
(`src/httpRoutes.ts`): `RpcServer.layerProtocolHttp({ path: samHttpPath(Auction) })`
(`POST /sam/auction/http`) with `RpcSerialization.layerNdjson`, beside the websocket route, from the
same `HttpRouter.serve`, so both protocols serve the one loop (`Loop` is built once and provided to
every route layer). It does not depend on `MUFW_RPCS`: it is open to any origin, so it serves only
`Representations`, and `Submit`, `Present`, `Dispatch`, `History`, `TravelTo` and `Replay` are not routed
there (the call dies with `Unknown request tag`). `RpcServer.layer` takes one protocol, hence the
second layer. The same module adds `HttpRouter.cors` (any origin, `POST`, no credentials): a page on
another origin, such as the vite dev server, preflights the request with `fetch`, and the middleware
is global to the router, so the rendered page also carries the header (it is public). A subscriber
is one open `POST`: the response is NDJSON, one `Chunk` line per representation, until the client
disconnects. The HTTP handlers hold one representation (`RepresentationBacklog` set to 1 by
`layerLatestOnly` in `src/httpRoutes.ts`): a reader that stalls skips to the latest snapshot instead
of making the server keep every one (see [Stalled clients](#stalled-clients)).

With `MUFW_STORE` unset the loop is `layerLoopLocal`. With a directory it is `layerLoopPersisted`
over `layerAtomicFileStore(directory)` (`src/persistence.ts`; `NodeFileSystem`, `NodePath`): one file
per key, so `<directory>/auction` holds the model as JSON, written after every step and travel (see
[Persistence](sam-loop.md#persistence), which says what a crash or a power loss leaves). `set` writes
`<directory>/auction.tmp`, syncs it, renames it onto the key's file and syncs the directory, because
`KeyValueStore.layerFileSystem` writes in place and a write interrupted at shutdown leaves the file
empty.
The server starts from that model; a file that does not decode, or a directory that cannot be opened,
stops the server at start with a typed error. To recover, delete `<directory>/auction` (the auction
starts from `Auction.initial`) or fix its JSON, then start again. Use one server per directory: two
processes overwrite each other's file.

With `MUFW_SYNC` the loop is `layerLoopSynced` over a `SyncLog` (`layerAuctionSync`, `src/sync.ts`; see
[Synchronisation across instances](sam-loop.md#synchronisation-across-instances)). `host` serves the
event-log RPCs (`RpcServer.layer(SyncRpcs)` over `layerSyncServer(Auction)` and
`layerSyncAuthorization`: the stock event-log RPCs plus `Sync.Head`, which answers the log's id and the sequence of its newest entry) with `RpcServer.layerProtocolWebsocket({ path: "/eventlog" })` and
`RpcSerialization.layerSchemaBinary()` in a second `HttpRouter.serve` on its own `NodeHttpServer`, at
`MUFW_SYNC_HOST:MUFW_SYNC_PORT` (`127.0.0.1:3101` by default), and reads and writes the same `Storage`
in-process (`layerSyncLogStorage`): in memory (`layerSyncStorageMemory`, so a restart starts a new log), or `layerSyncStorage` over the file store with
`MUFW_STORE`. Both provide the `SyncHead` that each subscription is checked against; Effect's bare `layerStorageMemory` does not, and no sync layer accepts it. The event log is not on the public port: whoever can
write to it appends proposals that every instance applies without a session or a credit check, and
the server's authorization sees a generated key, not the connection, so no secret can guard it. What
keeps it private is the listener: loopback by default, a private interface when instances run on
several machines, never reachable from clients. The routes and the loop share one
`Storage` because both are built from one `layerSyncServer` value; `server.ts` provides the loop
outside the public `HttpRouter.serve` (`Layer.provide(Loop)` after it) because a layer built inside
a `serve` is private to that router. A `ws://<host>:<sync port>/eventlog` target joins that
log through `layerSyncLogRemote` over `RpcClient.layerProtocolSocket` (redialling without end,
`layerHoldRequestsWhileDisconnected`) and `NodeSocket.layerWebSocket`, and asks `Sync.Head` at every subscription. The public listener is bound
before the loop is built and no route exists until the log has been reached and replayed, since every
route layer needs the loop: an instance started while its host is unreachable accepts connections
and answers none until then. The server refuses `MUFW_SYNC` with `TravelTo` or `Replay` in
`MUFW_RPCS` (they would move this instance's model away from the log's), with a `SyncConfigError`.

`MUFW_STORE` combines with it (`layerAuctionSync` takes the store as an option): the loop is then
`layerLoopSyncedPersisted` over the directory's file store, which holds the instance's checkpoint
under `<directory>/auction`, and on the host `layerSyncStorage` over the same store holds the log
(`auction%2Flog%2Fid`, `auction%2Flog%2F<n>`, and `auction%2Flog%2Fstart` once the log has been cut). A checkpoint of another log or a bare model in
`<directory>/auction` stops the server at start (`SyncLogMismatch`, `SchemaError`), and so does a
checkpoint past the end of the log (`SyncLogBehind`: a store that lost its newest entries, a restored backup); the checkpoint is left as it
was, and a log that is refused gets no `Joined`. The log is checked at every subscription, so a running instance stops the same way when its host is replaced
(`SyncLogMismatch`) or restarted over a store that lost entries (`SyncLogBehind`). A log restored from a backup and
grown back past a checkpoint is not noticed. `server.ts` creates one `Deferred` (`syncStopped`), passes it to `layerAuctionSync` as the
loop's `stopped`, and races `Layer.launch` against it, so an instance that stops applying (`SyncLogMismatch`, `SyncLogBehind`, or
`SyncSnapshotUnreadable` for a snapshot it cannot read) ends the process with that stop (exit code 1) instead of serving a model nothing updates. Each
instance needs a directory of its own.

A host with `MUFW_STORE` cuts its log: once its loop has applied `MUFW_SYNC_CUT_EVERY` entries past the log's last cut, `SyncLog.cut` (from the
`SyncStorageCut` that `layerSyncStorage` provides) replaces entries `1..through` by one `Snapshot` of the
host's model and lease, stored at sequence `through`, so sequences, the log's id and every checkpoint keep their meaning.
An instance that reads a snapshot (a joiner with no checkpoint, or one from before the cut) installs its lease, restores its
model (a history record of kind `restore`, no proposal), runs `nap` again and releases the callers
waiting on an entry the snapshot stands for. `<directory>/auction%2Flog%2Fstart` is written when a cut retires older
segments; a segment that begins with a `Snapshot` starts at its `through`, the last such segment wins on load, and a load removes
what an interrupted cut left behind. The snapshot keeps the ids of the last `every` entries it stands for, so a writer's resend of an entry that was cut away is
dropped; a writer cut off for longer than that may get a resend stored again. A memory host and a joiner cannot cut
(`options.cut` fails the build with `SyncCutUnsupported`), so the example passes it only to a host with a store. A client may never write a
`Snapshot`: `layerSyncAuthorization` refuses it (`"Snapshot" is not an event a client may write to this log`), and the server's handler and the storage refuse it
too.

`MUFW_AUTO_ACTIONS` defaults to `on` everywhere: with `MUFW_SYNC`
every instance that has it takes part in the lease that decides which one runs the automatic actions
(the first to build against a log nobody has claimed, then whoever takes it over after the holder has
been silent for 15 seconds), and `off` is an instance that never ticks. A restarted instance holds nothing
until it wins an epoch, so a lone one resumes ticking after the timeout. An automatic action's proposal is
written as `AutoProposal { epoch, proposal }`, the epoch being the one the instance held when the action started
(`AutoActionsGate.admit`, kept as `AutoEpoch`); every instance skips one whose epoch is not the lease's at its position in the log, so the proposal of a holder deposed
while its action ran stays in the log and changes no model. The fence guards honest stale holders, not a hostile writer on the trusted endpoint. A user intent's
proposal is a `Proposal` and is never skipped.

Upgrade hosts before joiners: a joiner waits against a host that does not serve `Sync.Head`, retrying the subscription every second. Upgrade every instance
of a log together for `AutoProposal` and `Snapshot`: an instance that does not know them ignores the entry and diverges, and a host with a store cuts by default.

`pnpm
--filter @mufw/example-auction test:sync` (`test/syncLive.ts`) bids on two running servers at once and
fails unless both hold the same bids in the same order; `test:sync:restart`
(`test/syncRestartLive.ts`) starts a host (cutting every 4 entries) and a joiner with stores, restarts the host over its store
(log, id and model survive, the joiner keeps converging in both directions), restarts the joiner (its
only record is the checkpoint's model, no entry replayed), starts a joiner with no store that begins from the host's snapshot (its records are
`init`, `restore`, then steps, holding every bid), starts the host over an empty store (the
joiner exits on `SyncLogMismatch`), and restarts a host over a store whose log lost its entries and kept its id (a joiner of that log exits on `SyncLogBehind`);
`test:sync:failover` (`test/syncFailoverLive.ts`) starts a host that
never ticks and two joiners, kills the one that holds the lease and fails unless nothing ticks until the
lease has timed out, the other joiner then takes it over and the host and that joiner show the same
auction as it goes on ticking.

`pnpm start:server` uses the defaults; `pnpm dev:server` serves every RPC for the demo and the
other pages. The live path test needs `Submit`, `Present`, `Representations`, `History` and `TravelTo`,
and a server without `MUFW_STORE` or with an empty store directory: its path tests travel to seq 0 and
expect `Auction.initial`, which a restarted server replaces with the stored model. The wallet's live
path test (`test/walletLive.ts`, `test:live:wallet`) replays its shortest paths over `Present` at
`/sam/wallet` and needs `Present`, `Representations`, `History` and `TravelTo`; its seq 0 is
`Wallet.initial` on any freshly started server, since the wallet is never persisted or synced.

### Connections and HTTP/2

`layerListener` is the public listener. Without `MUFW_TLS_CERT` and `MUFW_TLS_KEY` it is
`createServer` behind `layerNodeServer`, a `NodeHttpServer` that tracks its connections:
HTTP/1.1 on a plain socket. With both it is
`http2.createSecureServer({ cert, key, allowHTTP1: true })` behind the same `layerNodeServer`,
and each connection picks `h2` or `http/1.1` by ALPN. The files are read when the layer is built, so
an unreadable file (`PlatformError`) or a lone variable (`TlsConfigError`) stops the server at start.
Browsers negotiate HTTP/2 only over TLS, which is why the certificate is the switch. The
event-log listener of `MUFW_SYNC=host` stays plain HTTP on loopback.

Stopping (`SIGINT`/`SIGTERM`, which `NodeRuntime.runMain` turns into closing the scope) ends every
connection within a bound, for the public listener and the event-log listener alike, because both
are built by `layerNodeServer`. `NodeHttpServer` alone would not: it calls `server.close()`, which
resolves when the last connection ends, and its websocket server waits for each client to answer the
close frame. One open websocket, never-ending response or silent client then keeps the process up,
and the instance keeps answering its connected pages. `layerNodeServer` first lets requests in flight
finish for `SHUTDOWN_GRACE` (2 s; `NodeHttpServer`'s own default is 20 s) and interrupts the rest, so a
websocket gets its close frame; a second after that it destroys every TCP connection still open. It
tracks them through the `connection` event, which also sees an upgraded websocket and an HTTP/2
session, neither of which `closeAllConnections()` closes. The destroy has to run beside the server's
own finalizers, since those are what wait on the connections, so the server is built in a scope of
its own that the layer closes together with that timer. Clients reconnect, so ending their connections
is the intended outcome; `test/listener.test.ts` stops a listener holding a websocket, a websocket
whose client never answers, and a never-ending `h2` response, plain and TLS, and checks that each
client sees its connection closed.

`NodeHttpServer` takes the server as an `http.Server` and handles its `request` and `upgrade` events.
A connection that negotiated `h2` emits `request` with `Http2ServerRequest` and
`Http2ServerResponse`, whose `writeHead`, `write`, `end`, `drain`, `close` and `writableEnded` are the
calls the handler makes, so routes, streamed bodies and a client that hangs up work as they do on
HTTP/1.1. A connection that negotiated `http/1.1` (`allowHTTP1`) emits `request` with the usual
`IncomingMessage` and `ServerResponse`, and `upgrade`. The one cast in the listener reads the
`Http2SecureServer` as an `http.Server`; `test/listener.test.ts` runs a request, a never-ending
response and a websocket upgrade through it with a `node:http2` client and a generated certificate.

Over `h2` every request to the origin is a stream of one connection: `GET /`, `/assets/*`, each
`<iframe>`'s `GET /stream/<name>`, and the ticker's `POST /sam/auction/http`. Node's default
`maxConcurrentStreams` is 4294967295 and the listener does not change it, so the browser's own limit
is the only one.

The websocket is not one of those streams. A browser opens it with an HTTP/1.1 `Upgrade`, on a
connection of its own, unless the server advertises `SETTINGS_ENABLE_CONNECT_PROTOCOL`
([RFC 8441](https://www.rfc-editor.org/rfc/rfc8441)); Chromium uses WebSockets over HTTP/2 only on an
HTTP/2 connection whose server has advertised it
([Chrome Platform Status](https://chromestatus.com/feature/6251293127475200)). The listener leaves
`enableConnectProtocol` at Node's default, off, and `NodeHttpServer` would not serve such a stream
anyway: it turns only HTTP/1.1 `upgrade` events into `HttpServerRequest.upgrade`, and a Node HTTP/2
server with no `connect` listener answers an extended `CONNECT` with 405.

That connection does not count against the HTTP/1.1 cap. Chromium keeps websockets in a socket pool
of their own, whose limit per origin is 255 against 6 for the normal pool; its comment gives the
reason, that websocket connections are long-lived, and notes that Firefox uses 200
([`net/socket/client_socket_pool_manager.cc`](https://chromium.googlesource.com/chromium/src/net/+/refs/heads/main/socket/client_socket_pool_manager.cc)).
[RFC 6455 §4.1](https://www.rfc-editor.org/rfc/rfc6455#section-4.1) only requires a client to
serialize the handshakes to one address, not to cap open sockets. What exhausts the six connections
are the HTTP stream and the `<iframe>` of each tab, and those are what HTTP/2 multiplexes: with the
certificate set, more than six `<iframe>`s of `/stream/auction` on one origin all render in Chromium,
with websockets open beside them, where over HTTP/1.1 the seventh and later stay blank.

### Server-rendered first paint

With `MUFW_SSR=<deployment>` the server also answers `GET /` and `GET /assets/*`
(`src/ssrRoutes.ts`, a `Layer` merged next to the RPC routes in the same `HttpRouter.serve`; the
loop is provided once outside it, so every route gets the one instance). It needs
`HistoryPort`; the file system and `HttpPlatform` are the ones `NodeHttpServer` provides. Run
`pnpm build:client` first: the server reads what it wrote.

- `GET /` reads `dist/<deployment>/<page>.html` on every request (`ssrPages` in `src/ssr.ts` names the
  file: the page of `scripts/pages.ts`, `index.html` for `demo`) and renders
  `makeAuctionViewWith(html)(label)(representation, () => {})` with `makeSsr()` into the empty
  `<div id="app">`. The representation is the one of the server's latest history record, which a
  follower fiber keeps current; the record carries the model too, so a page never mixes steps. The
  label is `pageLabels[deployment](query)` (`src/client/labels.ts`), the function the page entry calls
  with `location.search`, so `?bidder=bob` gives the footer the browser will render.
- A deployment whose browser owns the auction model (`demo`, `browser-only`, `server-actions`; the
  fixed pages by their `placements` entry) also
  gets `<script type="application/json" id="mufw:auction">` after `#app`: the record's model as JSON
  (`Schema.fromJsonString(Schema.toCodecJson(Model))`, so an `Option` is plain JSON), with `<`
  written `\u003c` so that no string of the model can close the element. The placement reads it
  at its composition root: `auctionModelLocal` (`src/client/placements/auctionLocal.ts`) decodes the
  text with `decodeSnapshot` and passes the model as `layerModelLocal(Auction, Ports, { initial })`,
  so seq 0 of the page's history is the server's model. A page with no element (the vite dev
  server renders nothing) starts from `Auction.initial`; an element that does not decode fails the
  placement's layer with the `SchemaError` that `PagePorts` already carries. The snapshot keeps the
  server's `now`; the browser's own ticks move it on.
- `GET /assets/*` serves `dist/<deployment>/assets/<path>` with `HttpServerResponse.file`. The
  router's wildcard is decoded as an `AssetPath` (`src/ssr.ts`) first: segments of letters, digits,
  `.`, `_` and `-`, none `.` or `..`. Anything else answers 400 without touching the file system, a
  missing file 404.
- `worker` and `devtools` are not rendered: the first starts from a model of its own, the second has
  no auction view.

Hydration is a takeover. uhtml has no hydration API, so the first representation the browser
computes is rendered again over the server's markup, and it is not byte-identical: the amount input's
`.value` is a property binding, so the server's `<input>` has no `value` attribute and the browser
sets the minimum bid on it. The bid form is `method="dialog"`, which does not navigate outside a
`<dialog>`, so a submit before the bundle mounts `onsubmit` does nothing (a plain form would submit
as GET and replace the query, and with it the session). What the server buys is that the page is
visible before the socket connects.

### HTML over the wire

`GET /stream/<name>` (`src/streamRoutes.ts`; `samStreamPath(def)` in `src/samPath.ts` is the path)
is an island with no client bundle and no socket of its own: the response is HTML that stays open.
It is a `Layer` merged next to the RPC routes in the same `HttpRouter.serve`, so it reads the same
loop's `ModelPort.representations`; it needs no built page, so it does not depend on `MUFW_SSR`.
`<name>` is decoded against the definitions the route serves (`Schema.Literals([Auction.name])`);
any other name answers 404 before a subscription is made.

- The first representation (the current one) is the document: `<!doctype html>`, a small inline
  stylesheet, the one inline script (`mufwReplace`) and `<fieldset disabled><div id="app">…</div></fieldset>`,
  rendered by `renderApp` (`src/ssr.ts`) with `makeSsr()`. `<html>` and `<body>` stay open.
- Every later representation is `<template id="mufw-next">markup</template><script>mufwReplace()\n</script>`
  (the newline is inside the script, so removing it leaves no text behind).
  The function moves the template's content into `#app` (`replaceChildren`, the same result as
  assigning `innerHTML`) and removes the template and the calling script, so the document does not
  grow with the number of updates. The markup is the content of a `<template>`, never part of script
  source, and uhtml escapes `<`, `>`, `&` and quotes in every value, so a bid string cannot end the
  template.
- The footer reads `html stream · display only`, not a `pageLabels` entry: those carry the page's
  placement and identity, and this page has neither.
- It is display-only: the platform disables every control inside the `<fieldset>`, with or without
  script, and the route answers `GET` only and never reaches an intent port. The content stays in the
  accessibility tree, which `inert` would take it out of.
- Headers: `content-type: text/html; charset=utf-8`, `cache-control: no-store`,
  `x-accel-buffering: no` and `x-content-type-options: nosniff`, so no cache or proxy holds a chunk
  and the browser paints without waiting to sniff a type.
- The response is `HttpServerResponse.stream`; `NodeHttpServer` writes each chunk as it is emitted and
  interrupts the request's fiber when the client closes the connection, which ends the stream and
  releases its subscription. `test/htmlStream.test.ts` observes it through a `ModelPort` whose
  `representations` reports its end.
- A reader that stops reading costs the server one view, not a queue: the subscription is drained into
  a sliding buffer of one (`Stream.buffer({ capacity: 1, strategy: "sliding" })`), so a slow client
  skips to the latest view and never sees the ones in between. `test/htmlStream.test.ts` checks it
  with a reader stalled on the first chunk.
- It is served whatever `MUFW_RPCS` says, like the read-only HTTP endpoint: it shows what
  `Representations` shows and nothing more.

The demo page embeds it in an `<iframe id="stream">` that `src/client/streamEmbed.ts` points at the
server of the build (`VITE_SERVER_URL`, its `ws` origin read as `http`) once the page has loaded: a
frame whose document never ends would otherwise keep the page's own `load` from firing. The frame is
the whole island, and the page ships no code to draw or update it.
