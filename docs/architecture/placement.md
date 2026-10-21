# Placement

Living document. Source of truth: `packages/core/src/Ports.ts`, `Layers.ts`, `packages/rpc/src/index.ts`,
`examples/auction/src/client.ts`, `server.ts`.

## Ports

`makePorts(def)` returns four service keys, identified as `${def.name}/<Port>`:

| Port | Shape |
|---|---|
| `IntentBus` | `dispatch(intent)`, `dispatchAuto(intent)`, `intents: Stream<IntentEnvelope>` |
| `ActionRunner` | `run(intent): Effect<proposal, ActionFailure>` |
| `ModelPort` | `present(proposal)`, `representations: Stream` (current value first, then changes) |
| `HistoryPort` | `records: Stream<StepRecord>` (existing first, then live), `travelTo(seq)` |

## Layers

| Layer | Provides | Requires |
|---|---|---|
| `layerIntentBus` | `IntentBus` | — |
| `layerModelLocal` | `ModelPort`, `HistoryPort` (one state object) | `IntentBus` |
| `layerActionRunnerLocal` | `ActionRunner` | the actions' services `R` |
| `layerActionsDrain` | — (background fiber) | `IntentBus`, `ActionRunner`, `ModelPort` |
| `layerLoopLocal` | all four ports, drain running | `R` |
| `Rpc.layerModelRemote` / `layerHistoryRemote` / `layerActionRunnerRemote` | the port | `Rpc.Client` |
| `Rpc.layerClient` | `Rpc.Client` | `RpcClient.Protocol` (transport chosen by the app) |
| `Rpc.layerClientTest` | `Rpc.Client` | `Rpc.layerHandlers` (in-process, no serialization) |
| `Rpc.layerHandlers` | the RPC handlers | `ModelPort`, `HistoryPort`, `ActionRunner` |

`IntentBus` and `ActionsDrain` always run where the view runs. The server always hosts the whole
local loop and exposes every RPC, so any client placement works against the same server.

## Wire contract

`makeRpc(def, ports).group`:

| RPC | Payload | Success | Error |
|---|---|---|---|
| `Present` | proposal | void | — |
| `Representations` | — | stream of representation | — |
| `Dispatch` | intent | proposal | `ActionFailure` |
| `History` | — | stream of `StepRecord` | — |
| `TravelTo` | `{ seq: Int }` | void | `NoSuchStep` |

## The four placements

The client picks two layers and nothing else:

```ts
const ModelLayer = placement.model === "client"
  ? layerModelLocal(Auction, Ports)
  : Layer.merge(Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(Layer.provide(Transport))

const RunnerLayer = placement.actions === "client"
  ? layerActionRunnerLocal(Auction, Ports).pipe(Layer.provide(CreditCheck.layerPermissive))
  : Rpc.layerActionRunnerRemote.pipe(Layer.provide(Transport))
```

`Transport` is one layer value, so both remote ports share one connection, and a fully local
placement never opens one.

| Model | Actions | Round trips per user intent | Where `nap` runs |
|---|---|---|---|
| client | client | 0 | browser |
| server | server | 2 (`Dispatch`, `Present`) | server; the browser only streams representations |
| server | client | 1 (`Present`) | server |
| client | server | 1 (`Dispatch`) | browser; each automatic `Tick` is a `Dispatch` |

A rule that must hold (the credit limit) belongs to an action placed on the server: with
`actions:client` the browser provides its own `CreditCheck`, and the example shows it accepting a
bid over the limit.

## Server wiring

`RpcServer.layer(group)` + `Rpc.layerHandlers` + the local loop (with `CreditCheck.layerLive` and
`AutoActions`) + `RpcServer.layerProtocolWebsocket({ path: "/sam" })` + JSON serialization, served
by `HttpRouter.serve` on `NodeHttpServer` port 3001. `MUFW_AUTO_ACTIONS=off` disables automatic
actions for live path tests.
