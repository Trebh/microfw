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
  giving four placements of the same component, each its own deployment, against the same server code.
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
pnpm dev:server   # demo server on :3001: websocket RPC at /sam, every RPC served
pnpm dev:client   # vite on http://localhost:5173
```

Each deployment is its own page, with its own entry point and its own composition of layers:

| Page | Model | Actions | RPCs it needs |
|---|---|---|---|
| `/browser-only.html` | browser | browser | none |
| `/server-owned.html` | server | server | `Submit`, `Representations`, `History` |
| `/server-model.html` | server | browser | `Present`, `Representations`, `History` |
| `/server-actions.html` | browser | server | `Dispatch` |
| `/` (demo) | picked at runtime from `?placement=model:server,actions:client` | | all of the above |

Add `?bidder=bob` to bid as someone else, and `inspect=1` then **Open Stately inspector** to see
the diagrams. The server's auction lasts 60 seconds from process start; restart the server for a
fresh one.

The credit check (`alice` may bid up to 100, `bob` up to 1000) lives on the server. With actions in
the browser, the page brings a permissive check and the server applies whatever it presents, which
is how the example shows why that rule must run server-side.

The server is configured, not switched at runtime:

| Variable | Values | Default |
|---|---|---|
| `MUFW_RPCS` | comma-separated RPC tags to serve; the rest are not routed | `Submit,Representations,History` |
| `MUFW_AUTO_ACTIONS` | `on`, `off` | `on` |

`pnpm start:server` runs with the defaults, which serve only `/server-owned.html`; `pnpm dev:server`
serves every RPC so every page works. `pnpm build:client` builds all pages in one build: each gets
its own entry and placement chunk over a shared library chunk, the permissive credit check loads
only on pages that run actions in the browser, and the credit table is in no client chunk.

Replay the model-based paths against a live server:

```sh
MUFW_AUTO_ACTIONS=off pnpm dev:server
pnpm --filter @mufw/example-auction test:live   # MUFW_SERVER overrides ws://localhost:3001/sam
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
