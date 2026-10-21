# Placement

Living document. Source of truth: `packages/core/src/Ports.ts`, `Layers.ts`, `packages/rpc/src/index.ts`,
`examples/auction/src/client/`, `examples/auction/src/server.ts`.

Placement is a deployment decision. Each deployment has its own composition root, which chooses
layers; nothing is switched at runtime except on the demo page.

## Ports

`makePorts(def)` returns five service keys, identified as `${def.name}/<Port>`:

| Port | Shape | Used by |
|---|---|---|
| `IntentPort` | `dispatch(intent)` | the view, `intentDriver`: where user intents enter the loop |
| `IntentBus` | `dispatch`, `dispatchAuto`, `intents: Stream<IntentEnvelope>` | the local loop: the queue in front of `ActionsDrain` |
| `ActionRunner` | `run(intent): Effect<proposal, ActionFailure>` | `ActionsDrain` |
| `ModelPort` | `present(proposal)`, `representations: Stream` (current value first) | `ActionsDrain`, the view, `presentDriver` |
| `HistoryPort` | `records: Stream<StepRecord>` (existing first, then live), `travelTo(seq)` | devtools, test runner |

`IntentPort` is separate from `IntentBus` because a page whose server runs the actions has no
local queue: its intents go straight to the server.

## Layers

| Layer | Provides | Requires |
|---|---|---|
| `layerIntentBus` | `IntentBus`, `IntentPort` (local) | — |
| `layerModelLocal` | `ModelPort`, `HistoryPort` (one state object) | `IntentBus` |
| `layerActionRunnerLocal` | `ActionRunner` | the actions' services `R` |
| `layerActionsDrain` | — (background fiber) | `IntentBus`, `ActionRunner`, `ModelPort` |
| `layerLoopLocal` | all five ports, drain running | `R` |
| `Rpc.layerIntentPortRemote` / `layerModelRemote` / `layerHistoryRemote` / `layerActionRunnerRemote` | the port | `Rpc.Client` |
| `Rpc.layerClient` | `Rpc.Client` | `RpcClient.Protocol` (transport chosen by the app) |
| `Rpc.layerClientTest` | `Rpc.Client` | `Rpc.layerHandlers` (in-process, no serialization) |
| `Rpc.layerHandlers` | the RPC handlers | `IntentPort`, `ModelPort`, `HistoryPort`, `ActionRunner` |

## Wire contract

`makeRpc(def, ports).group`:

| RPC | Payload | Success | Error | Trust |
|---|---|---|---|---|
| `Submit` | intent | void | — | the server runs the action and its own model |
| `Present` | proposal | void | — | the server applies whatever the client computed |
| `Dispatch` | intent | proposal | `ActionFailure` | the server runs one action for a client-side model |
| `Representations` | — | stream of representation | — | read-only |
| `History` | — | stream of `StepRecord` | — | read-only |
| `TravelTo` | `{ seq: Int }` | void | `NoSuchStep` | rewrites the server's model; development only |

`Rpc.exposing(tags)` is the group a server serves: an RPC not listed is not routed, so calling it
fails on the client and changes nothing on the server.

## Deployments

Each page of the example is one deployment. Its entry point
(`src/client/<page>.ts`) calls one placement from `src/client/placements/` and `runPage`, which
mounts the view and the devtools over it.

| Page | Model | Actions | Placement layers | RPCs needed |
|---|---|---|---|---|
| `browser-only` | browser | browser | `layerLoopLocal` + permissive credit check | none |
| `server-owned` | server | server | remote `IntentPort`, `ModelPort`, `HistoryPort` | `Submit`, `Representations`, `History` |
| `server-model` | server | browser | local bus, drain, runner (permissive) + remote model and history | `Present`, `Representations`, `History` |
| `server-actions` | browser | server | local bus, drain, model + remote runner | `Dispatch` |
| `index` (demo) | from `?placement=` | | any of the four, chosen at runtime | all |

- Each placement is its own module, so it is its own chunk in the build. Library code (`@mufw/core`,
  `@mufw/rpc`) lands in one chunk shared by every page, so a server-owned page still loads the
  local model and runner code; per-deployment builds are in [TODO.md](../TODO.md).
- Each placement calls `transport()` once; the returned layer value is built once, so its remote
  ports share one connection, and `browser-only` never opens one.
- Domain services follow the same rule: `src/domain/CreditCheck.ts` is only the port, the server's
  table is `src/adapters/creditCheckTable.ts` and the browser's stand-in is
  `src/adapters/creditCheckPermissive.ts`, so no page ships the server's limits.

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
`layerCreditCheckTable` and `AutoActions`) + `RpcServer.layerProtocolWebsocket({ path: "/sam" })` +
JSON serialization, served by `HttpRouter.serve` on `NodeHttpServer` port 3001.

`pnpm start:server` uses the defaults; `pnpm dev:server` serves every RPC for the demo and the
other pages; the live path test needs `Present`, `Representations` and `TravelTo`.
