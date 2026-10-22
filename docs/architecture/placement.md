# Placement

Living document. Source of truth: `packages/core/src/Ports.ts`, `Layers.ts`, `packages/rpc/src/index.ts`,
`examples/auction/src/client/`, `examples/auction/src/server.ts`.

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
| `HistoryPort` | `records: Stream<StepRecord>` (retained first, then live), `travelTo(seq)` (`NoSuchStep` for an evicted seq) | devtools, test runner |

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
| `layerModelLocal` | `ModelPort`, `HistoryPort` (one state object) | `IntentBus` |
| `layerActionRunnerLocal` | `ActionRunner` | the actions' services except the ports' `R`, which `run`'s caller supplies |
| `layerActionsDrain` | — (background fiber) | `IntentBus`, `ActionRunner`, `ModelPort` |
| `layerLoopLocal` | all five ports, drain running | the actions' services except the ports' `R` |
| `Rpc.layerIntentPortRemote` / `layerModelRemote` / `layerHistoryRemote` / `layerActionRunnerRemote` | the port | `Rpc.Client` |
| `Rpc.layerClient` | `Rpc.Client` | `RpcClient.Protocol` (transport chosen by the app), the client half of the authentication middleware |
| `Rpc.layerClientTest` | `Rpc.Client` | `Rpc.layerHandlers`, the authentication middleware on both sides (in-process, no serialization) |
| `Rpc.layerHandlers` | the RPC handlers | `IntentPort`, `ModelPort`, `HistoryPort`, `ActionRunner`, and the ports' `R` except what the middleware provides |

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

`Submit` and `Dispatch` run actions, so `makeRpc(def, ports, authentication)` attaches the
`authentication` middleware (`RpcMiddleware`, error `Unauthenticated`) to them and to no other RPC.
`Present` and `TravelTo` stay unauthenticated: they are served only to clients the deployment
already trusts with the whole model, and `Representations` and `History` only read.

`Rpc.exposing(tags)` is the group a server serves: an RPC not listed is not routed, so calling it
fails on the client and changes nothing on the server.

## Identity

An intent never says who acts: `PlaceBid` carries an amount, and its action reads the bidder from
`CurrentBidder`, a port declared in `src/domain/CurrentBidder.ts` and required in the action's `R`.
Who provides it depends on where the action runs:

| Actions run | Provider of `CurrentBidder` | Source of the identity |
|---|---|---|
| on the server (`Submit`, `Dispatch`) | the `Authentication` middleware, per request | the session token the client sends in the `x-session-token` header, looked up in `Sessions` (`src/adapters/sessionsTable.ts`) |
| in the browser | `layerCurrentBidderFixed(bidder)` at the page's composition root | the page's `?bidder=`; the browser is already trusted with the model there (the server applies any proposal), so it vouches for itself |

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
(`src/client/<page>.ts`) calls one placement from `src/client/placements/` and `runPage`, which
mounts the view over it plus the devtools layer the entry passes: only the demo passes the
time-travel panel, because only it can rely on `TravelTo` being served.

| Page | Model | Actions | Placement layers | RPCs needed |
|---|---|---|---|---|
| `browser-only` | browser | browser | `layerLoopLocal` + permissive credit check + `?bidder=` identity | none |
| `server-owned` | server | server | remote `IntentPort`, `ModelPort`, `HistoryPort`, sending `?session=` | `Submit`, `Representations`, `History` |
| `server-model` | server | browser | local bus, drain, runner (permissive credit check, `?bidder=` identity) + remote model and history, anonymous | `Present`, `Representations`, `History` |
| `server-actions` | browser | server | local bus, drain, model + remote runner sending `?session=` | `Dispatch` |
| `index` (demo) | from `?placement=` | | any of the four, chosen at runtime | all |

- Each deployment is built on its own: `vite build --mode <deployment>` takes that page as its only
  entry and writes `dist/<deployment>`, so a server-owned bundle contains no local model or action
  runner (`demo` is the one build that holds all four placements). `pnpm build:client` builds
  every deployment and then runs `check:bundle`, which reads which exports of `@mufw/core` each
  build kept (`layerModelLocal`, `layerActionRunnerLocal`; names that survive minification) and
  fails when a deployment ships a local half it delegates, or lacks one it runs.
- Each placement calls `transport()` once; the returned layer value is built once, so its remote
  ports share one connection, and `browser-only` never opens one. The websocket URL is a
  build-time setting, `VITE_SERVER_URL` (typed in `src/client/env.d.ts`, defaulted in `.env`,
  overridable per deployment in `.env.<deployment>`), decoded once by `transport()` as a
  `ws://`/`wss://` URL.
- A lost websocket is redialled by `layerProtocolSocket` (`src/client/connection.ts`) with
  `reconnectSchedule` (500 ms growing by 1.5×, capped at 5 s, no limit) and
  `retryTransientErrors`, so a dial that cannot open leaves calls pending instead of failing them.
  The remote `ModelPort.representations` and `HistoryPort.records` resubscribe after a socket
  error (`@mufw/rpc`): the first representation after the reconnection is the server's current
  one, and `records` drops what it already delivered, or starts over when the server restarted
  (a new `init` record). A call (`present`, `dispatch`, `run`, `travelTo`) made while the socket
  is down is a defect, as before; the bid is not queued.
- Transport state is data outside the SAM representation: `Connection` is a `Context.Reference`
  holding a `Stream<"connecting" | "connected" | "disconnected">`, fed by the protocol's
  `ConnectionHooks`. `transport()` provides it and the placements merge it into their output with
  `Layer.provideMerge`; `runPage` mounts `layerConnectionBanner` over it. A page with no remote
  port provides nothing, reads the default (always `connected`) and shows no banner.
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

A rule that must hold (the credit limit) belongs to an action on the server, and the server must
not serve `Present` to untrusted clients: with `Present` served, any client can apply any proposal.

## Server

`src/server.ts` is the server's composition root. Configuration is parsed with `Config`, so a bad
value stops the server at start with a typed error:

| Variable | Parsed as | Default |
|---|---|---|
| `MUFW_RPCS` | `Config.Array(Schema.Literals(rpcTags))` | `Submit,Representations,History` |
| `MUFW_AUTO_ACTIONS` | `Config.Literals(["on", "off"])` | `on` |

Wiring: `RpcServer.layer(Rpc.exposing(rpcs))` + `Rpc.layerHandlers` + the local loop (with
`layerCreditCheckTable` and `AutoActions`, `CurrentBidder` left to the request) +
`layerAuthenticationServer` over `layerSessionsTable` + `RpcServer.layerProtocolWebsocket({ path: "/sam" })` +
JSON serialization, served by `HttpRouter.serve` on `NodeHttpServer` port 3001.

`pnpm start:server` uses the defaults; `pnpm dev:server` serves every RPC for the demo and the
other pages; the live path test needs `Submit`, `Present`, `Representations`, `History` and `TravelTo`.
