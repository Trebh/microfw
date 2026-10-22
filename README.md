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
  replays each generated path against the real system, in-process or over the wire, or by clicking
  the rendered UI and reading the DOM.
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

Query parameters: `?session=demo-bob` picks who a page bids as where the actions run on the server
(`server-owned`, `server-actions`); `?bidder=bob` does it where they run in the browser
(`browser-only`, `server-model`); `?inspect=1` then **Open Stately inspector** shows the diagrams.
The footer of each page says which one it uses. The auction opens when its loop starts, reading the loop's `Clock`, and lasts 60
seconds. While it is `opening` the bid form is disabled and the page shows an **Open auction** button that
submits `Open`: after a `travelTo(0)`, or on a server with `MUFW_AUTO_ACTIONS=off`, nothing else
would reopen it, because `nap` does not run after a travel and its intents are dropped without automatic actions.

An intent never carries who is bidding. The server reads the session token the client sends with
every `Submit` and `Dispatch` (the `x-session-token` request header), looks it up and runs the
action as that bidder; a request without a valid session fails with a typed `Unauthenticated`
error, and a `server-owned` page (`?session=` unknown) shows it as a notice above the auction. The
demo sessions are fixed in `src/adapters/sessionsTable.ts`:

| Token | Bidder |
|---|---|
| `demo-alice` (default) | `alice` |
| `demo-bob` | `bob` |

Where the actions run in the browser there is no server to vouch for the bidder, and the server
applies whatever proposal the page presents anyway, so the page states its own identity from
`?bidder=` (default `alice`) at its composition root. A server that serves only `Submit`,
`Representations` and `History` never believes a visitor about who is bidding.

The credit check (`alice` may bid up to 100, `bob` up to 1000) lives on the server. With actions in
the browser, the page brings a permissive check and the server applies whatever it presents, which
is how the example shows why that rule must run server-side.

The server is configured, not switched at runtime:

| Variable | Values | Default |
|---|---|---|
| `MUFW_RPCS` | comma-separated RPC tags to serve; the rest are not routed | `Submit,Representations,History` |
| `MUFW_AUTO_ACTIONS` | `on`, `off` | `on` |

`pnpm start:server` runs with the defaults, which serve only `/server-owned.html`; `pnpm dev:server`
serves every RPC so every page works.

The client is built per deployment, not as one bundle:

| Command | Does |
|---|---|
| `pnpm build:client` | one `vite build --mode <deployment>` per page into `examples/auction/dist/<deployment>` (`browser-only`, `server-owned`, `server-model`, `server-actions`, and `demo` with all four placements), then `check:bundle` |
| `pnpm --filter @mufw/example-auction check:bundle` | fails if a deployment ships a local half it should not (a `server-owned` bundle with the local model or action runner) or lacks one it should |

Each build has a single entry, so a `server-owned` bundle holds no local model or action runner, the
permissive credit check is only in builds that run actions in the browser, and the credit table is
in no client bundle. The server's websocket URL is a build-time setting: `VITE_SERVER_URL`, default
`ws://localhost:3001/sam` from `examples/auction/.env`; override it per deployment in
`.env.<deployment>` or in the environment (`VITE_SERVER_URL=wss://auction.example/sam pnpm build:client`).

Replay the model-based paths against a live server:

```sh
MUFW_AUTO_ACTIONS=off pnpm dev:server
pnpm --filter @mufw/example-auction test:live   # MUFW_SERVER overrides ws://localhost:3001/sam
```

The live test replays the paths over `Present`, then submits `Open` and a bid with the `demo-alice`
session and checks the accepted bid is alice's, and that a client with no session is refused.

The example's path tests also replay through the rendered view with `domDriver`: on uhtml's fake
DOM inside `pnpm test`, and in headless Chromium with

```sh
pnpm exec playwright install chromium   # once
pnpm test:browser
pnpm test:browser:ui                    # visible Chromium, steps slowed down, watch mode
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
