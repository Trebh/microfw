# µFW

µFW (`@mufw/*`) is a small TypeScript framework that implements the
[SAM pattern](https://sam.js.org/) (State–Action–Model) on [Effect 4](https://effect.website).
Which parts of the SAM loop run in the browser and which on the server is decided per deployment
by composing Effect `Layer`s; the domain code does not change.

Status: **proof of concept**. APIs move freely; there is no build step and nothing is published.

## What you get

- **A pure SAM definition.** Model, proposals, intents and representation are Effect `Schema`s;
  acceptors, reactors, `state` and `nap` are pure functions; only actions are effectful.
- **Placement by layers.** The model and the actions can each be local or remote (Effect RPC),
  giving four placements of the same component, all served by one server.
- **Time travel.** Every step is recorded; `travelTo(seq)` restores any recorded model.
- **Model-based testing.** `@mufw/test` explores the control-state graph from the definition and
  replays each generated path against the real system, in-process or over the wire.
- **Devtools.** A time-travel panel, and an adapter for the
  [Stately inspector](https://stately.ai/docs/inspector) that draws the state and sequence diagrams.

## Packages

| Package | Role |
|---|---|
| `@mufw/core` | Definition, pure step, ports, local layers, graph exploration |
| `@mufw/rpc` | Wire contract and remote adapters of the ports (platform-free) |
| `@mufw/view-uhtml` | Mounts a pure [uhtml](https://github.com/WebReflection/uhtml) v4 view |
| `@mufw/devtools` | Time-travel panel and Stately inspector adapter |
| `@mufw/test` | Model-based path testing (returns Effects; test-runner agnostic) |
| `@mufw/example-auction` | A live auction running in all four placements |

## Quick start

Requires Node 24 and pnpm 12.

```sh
pnpm install
pnpm typecheck
pnpm test
```

Run the example (two terminals):

```sh
pnpm dev:server   # auction server on :3001 (websocket RPC at /sam)
pnpm dev:client   # vite on http://localhost:5173
```

Then open one of the placements:

| URL query | Model | Actions |
|---|---|---|
| `?placement=model:client,actions:client&bidder=alice` | browser | browser |
| `?placement=model:server,actions:server&bidder=bob` | server | server |
| `?placement=model:server,actions:client&bidder=alice` | server | browser |
| `?placement=model:client,actions:server&bidder=alice` | browser | server |

Add `&inspect=1` and click **Open Stately inspector** to see the diagrams. The server's auction
lasts 60 seconds from process start; restart `pnpm dev:server` for a fresh one.

The credit check (`alice` may bid up to 100, `bob` up to 1000) lives on the server: with
`actions:client` the browser runs a permissive check, which is how the example shows why that rule
must run server-side.

Replay the model-based paths against a live server:

```sh
MUFW_AUTO_ACTIONS=off pnpm dev:server
pnpm --filter @mufw/example-auction test:live
```

## A definition, in short

```ts
export const Counter = define({
  name: "counter",
  model: Schema.Struct({ count: Schema.Int }),
  proposal: Schema.Union([Schema.TaggedStruct("Inc", { by: Schema.Int }), Schema.TaggedStruct("Reset", {})]),
  intent: Schema.Union([Schema.TaggedStruct("Inc", { by: Schema.Int }), Schema.TaggedStruct("AutoReset", {})]),
  representation: Schema.Struct({ controlState: Schema.Literals(["low", "high"]), count: Schema.Int })
})({
  controlStates: ["low", "high"],
  initial: { count: 0 },
  acceptors: [
    (model, proposal) => (proposal._tag === "Inc" ? { count: model.count + proposal.by } : model),
    (model, proposal) => (proposal._tag === "Reset" ? { count: 0 } : model)
  ],
  reactors: [],
  state: (model) => ({ controlState: model.count >= 3 ? "high" : "low", count: model.count }),
  nap: (representation) => (representation.count >= 3 ? Option.some({ _tag: "AutoReset" }) : Option.none()),
  actions: {
    Inc: (intent) => Effect.succeed({ _tag: "Inc", by: intent.by }),
    AutoReset: () => Effect.sleep("1 second").pipe(Effect.as({ _tag: "Reset" }))
  }
})

const Ports = makePorts(Counter)
const Everything = layerLoopLocal(Counter, Ports)      // or swap in @mufw/rpc's remote layers
```

## Documentation

These are living documents: they are updated in the same change that makes them false.

- [VISION.md](VISION.md) — why µFW exists and where it is going
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it is built, with the detailed pages under
  [docs/architecture/](docs/architecture/)
- [docs/TODO.md](docs/TODO.md) — known gaps and the roadmap
- [AGENTS.md](AGENTS.md) — rules for anyone (human or agent) changing the code
