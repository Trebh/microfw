# AGENTS.md

Instructions for anyone — human or coding agent — changing this repository. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before touching a package.

## Project

µFW is a SAM-pattern framework on Effect 4. A SAM definition is the domain; its ports are Effect
services; local and remote implementations are layers; the example (`examples/auction`) runs one
definition in four browser/server placements and in a web worker.

```
packages/core        @mufw/core        definition, nesting and composition, pure step, ports, local layers, forwarding, graph, history, persistence, sync
packages/rpc         @mufw/rpc         wire contract and remote adapters (no transport)
packages/view-uhtml  @mufw/view-uhtml  mounts a pure uhtml v4 view, keyed lists that release removed rows; `./ssr` renders one to markup in Node
packages/devtools    @mufw/devtools    time-travel panel, history list, Stately adapter
packages/test        @mufw/test        model-based path testing
examples/auction     @mufw/example-auction
examples/showcase    @mufw/example-showcase    a presentation of µFW as a theatre play: the deck is a definition, each act runs µFW live; browser only
examples/jfb         @mufw/example-jfb         the js-framework-benchmark keyed table in µFW and in plain uhtml 4, built into directories a js-framework-benchmark checkout can serve
docs/                ARCHITECTURE.md, architecture/*.md, TODO.md
```

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | install; pnpm 12 enforces a minimum release age, so a just-published version is refused |
| `pnpm typecheck` | `tsc --noEmit` in every package, one at a time |
| `pnpm test` | vitest over `packages/*/test` and `examples/*/test`, except `*.browser.test.ts` |
| `pnpm test:browser` | the `*.browser.test.ts` files in headless Chromium (once: `pnpm exec playwright install chromium`) |
| `pnpm test:browser:ui` | the same files in a visible Chromium, one step every 700 ms, in watch mode: re-runs on change, `q` quits |
| `pnpm dev:server` | demo server on :3001 serving every RPC (`MUFW_AUTO_ACTIONS=off` disables automatic actions) |
| `pnpm start:server` | server with the production defaults (`MUFW_RPCS=Submit,Representations,History`) |
| `pnpm cert` | with mkcert installed, writes a trusted-once `localhost` certificate and key to `examples/auction/.certs/`; the server speaks HTTPS and HTTP/2 when `MUFW_TLS_CERT` and `MUFW_TLS_KEY` name them |
| `pnpm dev:client` | vite on :5173: one page per deployment plus the demo page |
| `pnpm --filter @mufw/example-showcase dev` | vite on :5180: the showcase, a presentation of µFW in which each act runs µFW live in the browser (`build` and `preview` build and serve it; `typecheck` is part of `pnpm typecheck`) |
| `pnpm build:client` | one `vite build` per deployment into `examples/auction/dist/<deployment>`, then `check:bundle` |
| `pnpm --filter @mufw/example-auction test:live` | replays the path tests against a running server started without `MUFW_STORE` (or with an empty store): seq 0 must be `Auction.initial` |
| `pnpm --filter @mufw/example-auction test:live:wallet` | replays the wallet's path tests against the wallet a running server serves at `/sam/wallet`; any freshly started server has `Wallet.initial` at seq 0 |
| `pnpm --filter @mufw/example-auction test:sync` | against two running servers that share an event log (`MUFW_SYNC=host` on :3001 with its log on `127.0.0.1:3101`, `MUFW_PORT=3002 MUFW_SYNC=ws://127.0.0.1:3101/eventlog` on :3002, freshly started): bids on both at once and fails unless they end with the same bids |
| `pnpm --filter @mufw/example-auction test:sync:restart` | starts a host and a joiner of its own, each with a `MUFW_STORE`, on :3211 (log on :3311) and :3212; restarts the host over its store, then the joiner, then the host over an empty store, and fails unless the log, the model and the convergence survive the first two and the joiner stops on the third |
| `pnpm --filter @mufw/example-auction test:sync:failover` | starts a host that never ticks (`MUFW_AUTO_ACTIONS=off`) and two joiners of its own on :3221 (log on :3321), :3222 and :3223; kills the first joiner, which holds the lease, and fails unless nothing ticks until the lease has timed out, then the second joiner ticks, and the host and it show the same auction (takes about 30 seconds) |
| `pnpm --filter @mufw/example-auction compare:transports` | starts a server of its own, builds the two ticker pages and prints first paint and update latency of the websocket, HTTP and HTML-stream islands in headless Chromium (once: `pnpm exec playwright install chromium`) |
| `pnpm --filter @mufw/example-auction bench:bundle` | builds the Effect floors, the bench pages (`scripts/bench/pages/`: counter and 1000-row list, plain uhtml and µFW) and every deployment in memory and prints gzip/brotli size, size per origin and the largest modules |
| `pnpm --filter @mufw/example-auction bench:loop` | in Node: the cost of a step, an intent, concurrent presenters, subscribers, schema boundaries and history records, against a plain reducer |
| `pnpm --filter @mufw/example-auction bench:browser` | cold load and click latency of the bench pages and `browser-only` in headless Chromium at each `BENCH_CPU_RATES` throttling rate (default `1,4`), with µFW/uhtml ratios; ports 4600–4699 |
| `pnpm --filter @mufw/example-auction bench:server` | starts servers of its own on ports 4800–4999: `Present`/`Submit` throughput and latency, `Representations` fan-out, RSS as history fills, synced host and joiner latency |
| `pnpm --filter @mufw/example-jfb build` | builds the two js-framework-benchmark entries (`mufw`, and `uhtml4` as the plain-uhtml control) into `examples/jfb/out/keyed/<name>`, shaped like built `frameworks/keyed/<name>` directories, and prints each `dist/main.js` size |
| `pnpm --filter @mufw/example-jfb jfb:install <jfb-checkout>` | copies both built directories into `<jfb-checkout>/frameworks/keyed/`, replacing them; fails if the checkout or the build is missing |
| `pnpm --filter @mufw/example-jfb jfb:table <results-dir>` | prints the CPU, memory, size and comparison tables of a directory of js-framework-benchmark result files (`examples/jfb/results/` holds the pass `performance.md` reports); fails naming the file when an entry lacks a benchmark or a file does not parse |

A change is done when `pnpm typecheck` and `pnpm test` pass and the changed behaviour has been
exercised: a UI change in the browser, a server change against a running server.

Versions are pinned on purpose (`effect` 4.0.x, uhtml **v4**, TypeScript 5.9). Read the installed
`.d.ts` before using an API, and `node_modules/effect/AGENTS.md` plus `node_modules/effect/ai-docs/`
for Effect idioms; do not rely on Effect 3 knowledge.

## Architecture rules

### Hexagonal: dependencies point inward

- The domain is the `SamDefinition`: schemas plus pure `acceptors`, `reactors`, `state`, `nap`.
  Only `actions` are effectful, and they reach the outside world through services in their `R`.
- A port is a `Context.Service` key; an adapter is a `Layer` that provides it. The domain and
  `@mufw/core` never import an adapter, a transport, a DOM API or a platform package.
- `@mufw/core` depends on `effect` only. `@mufw/rpc` stays platform-free: transports and
  serialization are chosen by the application. Adapter packages do not depend on each other.
- Placement is decided per deployment, at its composition root (`src/client/<page>.ts` calling one
  module of `src/client/placements/`, `src/client/auctionWorker.ts`, `server.ts`, `test/live.ts`, `test/walletLive.ts`;
  the showcase's `examples/showcase/src/main.ts` and `src/acts/tour/company.worker.ts`),
  by choosing layers. Only the demo page picks a placement at runtime; never let a visitor choose
  what the server trusts. If moving a part between client and server needs a change outside the
  composition root, the design is wrong: fix the port, not the call site.
- A browser root provides `layerInputScheduler` (`@mufw/view-uhtml`) with `Layer.provide`, last,
  around the whole page. Provided lower, the loop's queue keeps the default scheduler and a click
  shows its step one frame late. The web worker and the server keep the default.

### Dependency injection and inversion

- Depend on the port, never on an implementation: `yield* ports.ModelPort`, `yield* CreditCheck`.
- Provide implementations only with `Layer`s, and only at the composition root or in a test.
- A service a domain action needs (`CreditCheck`) is a port declared in `src/domain/`; its
  implementations are adapters in their own modules under `src/adapters/`, so a bundle only
  contains the adapters its composition root imports. Never put a server-side implementation (and
  its secrets) in the module that declares the port.
- A server serves only the RPCs its deployment needs (`MUFW_RPCS`); it serves `Present` only to
  trusted clients, since it applies any proposal it receives.
- The event-log server of a synced host (`MUFW_SYNC=host`) applies any proposal it receives, as
  `Present` does, and its authorization cannot tell who writes. Serve it only to trusted instances:
  on a listener and router of its own (`MUFW_SYNC_PORT`, loopback unless `MUFW_SYNC_HOST` says
  otherwise), never on the public port or beside the client routes, and with an authorization that
  refuses every event the log does not define (`layerSyncAuthorization`).
- Tests replace a dependency by providing another layer, never by patching modules.

### Parse, don't validate

- Every cut point is an Effect `Schema`: model, proposal, intent, representation, history record,
  errors. New data that crosses a boundary gets a schema first.
- Decode untrusted input once, at the boundary, into the domain type (`Schema.decodeUnknownEffect`,
  `Config.schema`, RPC payload schemas). Inside, a value of a domain type is trusted: do not
  re-check it.
- Encode constraints in the type: `Schema.Int`, literals, tagged unions, brands. Prefer a refined
  schema to an `if` repeated in several acceptors.
- Never manufacture a domain value from `unknown` with `as`. A cast is allowed only where the type
  system cannot follow a generic definition, with a comment saying which concrete type it stands for.
- Business outcomes are proposals (`BidRejected`), not errors. Technical failures are typed errors
  (`Schema.TaggedError`). A transport lost under a call already written, or an impossible state, is a defect.
- Known gaps are listed in [docs/TODO.md](docs/TODO.md); do not add new ones.

### Effect, idiomatically

- `Effect.gen` for inline code; `Effect.fn("name")` for reusable traced functions,
  `Effect.fnUntraced` in library hot paths. Do not wrap an `Effect.gen` in a function that only
  returns it.
- Services with `Context.Service`, wiring with `Layer` (`Layer.effect`, `Layer.effectContext`,
  `Layer.effectDiscard` for background fibers), configuration with `Config` and
  `Context.Reference` for defaults (`AutoActions`).
- Errors in the error channel with `Schema.TaggedError`, handled with `Effect.catchTag`; never
  `throw` inside effectful code. Pure functions may throw only for authoring bugs (the graph limit, a `Child` tag clash in `nest`, a part name in `compose` that is not PascalCase or clashes with a parent tag).
- Sequences are `Stream`s; shared state is `Ref`/`SubscriptionRef`/`PubSub` under a `Semaphore`;
  resources and fibers are scoped (`Effect.forkScoped`, `Stream.unwrap`), never left dangling.
- Time comes from `Clock` (testable with `TestClock`), never `Date.now()` in effectful code.
- No `async`/`await` or `Promise` in library code; wrap foreign promises once with
  `Effect.promise`/`Effect.tryPromise`.

### Keep effects; fold them only at boundaries

Code stays in `Effect`/`Stream`/`Layer` through every layer of the application. Running an effect
(`runMain`, `runFork`, `runPromise`, `runSync`, `Layer.launch`) is allowed only at a boundary:

| Boundary | Place |
|---|---|
| Process entry point | `runPage` in `examples/auction/src/client/app.ts`, `runTicker` in `client/ticker.ts`, `runStreamFrame` in `client/streamEmbed.ts`, `client/devtools.ts`, `client/auctionWorker.ts` (the web worker), `server.ts`, `test/live.ts`, `test/walletLive.ts`, `test/syncLive.ts`, `test/syncRestartLive.ts`, `test/syncFailoverLive.ts`, the `scripts/`; `examples/showcase/src/main.ts` and `examples/showcase/src/acts/tour/company.worker.ts` (the web worker); `examples/jfb/src/mufw.ts` |
| DOM event handler | `layerMount` dispatch, `layerPanel` and `layerHistoryList` row and export clicks, the showcase's key presses, hash changes and spotlight observers (`examples/showcase/src/deck/keys.ts`, `hash.ts`, `spotlight.ts`) and Act VII's window controls (`src/acts/sync/index.ts`), through a `FiberSet.makeRuntime` runner captured from the layer |
| Test harness | `it.effect` / `layer` from `@effect/vitest` |

Anywhere else, return the effect and let the caller compose it. Do not convert an `Effect` to a
`Promise` and back mid-stack; do not `Effect.orDie` a typed error to make a signature simpler — only
transport loss is turned into a defect, in `@mufw/rpc`.

## SAM rules

- Acceptors, reactors, `state` and `nap` are pure and synchronous: no `Effect`, no clock, no I/O,
  no randomness. Put anything effectful in an action and pass its result in the proposal.
- One acceptor per proposal tag: `acceptors` is a record keyed by tag, and a tag the definition
  ignores is `Tag: unchanged`. A missing or extra key does not compile.
- The representation always carries `controlState`. One `nap` entry per control state, keyed by it,
  `noIntent` for a state with no automatic intent; `controlStates` is derived from those keys and
  never written (only `nest` and `compose` take a `controlStates` option).
- A `nap` entry returns at most one intent; the compiled `nap` returns a list, which a combinator (`nest`, `compose`) fills with one intent per part, and the loop dispatches every one. Automatic intents with an `intentKey` (default their tag) already in flight are skipped. In a synced loop `nap` runs on every instance and only the holder of the log's lease runs its intents, so an automatic action must be safe to interrupt when the instance loses the lease.
- Model mutation happens only in `layerModelLocal`, under its permit.

## Testing rules

- `@effect/vitest` (`it.effect`, `assert`), `TestClock` from `effect/testing` for time.
- One behaviour per test, a name that states the rule, Arrange–Act–Assert, literal expectations
  worked out by hand, no `if`/`for` in a test body.
- Domain logic is tested as pure functions with literal models (`examples/auction/test/auction/Auction.rules.test.ts`).
- Behaviour across states is tested with `@mufw/test`: a test model next to the definition, run
  with `AutoActions` false over the local loop and over `Rpc.layerClientTest`.
- Each definition with an explore function has a committed `<Unit>.behaviour.md` beside it, pinned by
  a `<Unit>.behaviour.test.ts` (`toMatchFileSnapshot`): it fails when stale, `vitest -u` rewrites it.
  The card shows only the proposals exploration sampled; its blind-spot ledger lists what no sample tried.
- Substitute dependencies with layers at real boundaries (transport, credit check, clock); never
  mock the model or the ports' internals.
- The shared counter fixture is `packages/core/test/fixtures/Counter.ts`.
- A test must be able to fail: when adding one for a rule, break the rule once and watch it fail.

## Code conventions

- TypeScript strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`; import with the `.ts`
  extension; type-only imports with `import type`.
- `define(schemas)(behaviour)`: keep the two calls, they are what types the behaviour's literals.
- Names in application code: an intent is an imperative verb phrase (`PlaceBid`, `Tick`); a proposal
  is a past-tense fact that never equals an intent tag of the same definition (`BidPlaced`,
  `Ticked`); an acceptor is `accept<ProposalTag>` exactly; a predicate a view reads is `can…` or
  `is…`, never `accept…`; the coarse lifecycle field of a model is `phase`. Tags are wire and
  stored data: a rename updates every fixture, stored JSON and literal that carries it. A test driver
  maps a proposal to an intent with an exhaustive switch, never by reusing its tag.
- Files: `<Unit>.ts` (PascalCase) holds exactly one `define(...)`; a lowercase file holds none. The
  unit's other roles are `<Unit>.<role>.ts`: `.view.ts` (the pure view, taking uhtml's `html` as a
  parameter, importing no uhtml runtime), `.view.dom.ts` (binds uhtml's `html`; the only module of
  the unit that imports uhtml's entry), `.explore.ts` (`explore` and `serialize`, shared by devtools
  and path tests), others named by what they are (`.feed.ts`). A definition never imports its view.
  In `examples/auction` each unit has a folder under `src/` and its tests mirror it under `test/`,
  named `<Unit>.<what>.test.ts`; shared ports and values stay in `src/domain/`, adapters in
  `src/adapters/`.
- Reading order of a definition file: vocabulary (schemas and their types); rules on the model (one
  acceptor per proposal tag, in the order of the `Proposal` union; a rule that only reads the model
  is a guard returning `Option<string>`, such as `bidRefusal`, that its acceptor uses); derivations
  (`state`, control-state derivation, `nap` entries, view predicates); actions, one per intent in
  intent order, each carrying the "why" only it needs; `define(...)` last, names only.
- Small, single-purpose functions; guard clauses over nesting; named intermediate values over dense
  one-liners; no boolean parameter that selects behaviour.
- Comments state a present-tense choice and its reason (an external constraint, a "why not"). No
  history, ticket numbers, or restatements of the code.
- Gotchas: uhtml's entry module needs a DOM at import time (import it lazily in packages, use
  `uhtml/init` + `uhtml/dom` in tests); `@statelyai/inspect` reads the diagram from
  `actorRef.logic.config`; `RpcTest.makeClient` returns a client, not a protocol.

## Living documents

README.md, VISION.md, docs/ARCHITECTURE.md, docs/architecture/*.md and docs/TODO.md describe the
code as it is. Update the affected document in the same change that makes it false:

| Change | Document |
|---|---|
| user-facing behaviour, commands, packages | README.md |
| direction, principles, non-goals | VISION.md |
| a port, layer, contract, boundary or design decision | docs/ARCHITECTURE.md and the matching page |
| a change to a definition (its schemas, acceptors, `nap`, explore function or samples) | its `<Unit>.behaviour.md`, regenerated with `vitest -u` and reviewed as part of the diff |
| a change that moves a measured cost (bundle, startup, step, interaction, server) | docs/architecture/performance.md, with the figures of a fresh run of the `bench:*` script that measures it |
| a gap found or closed | docs/TODO.md (add it, or delete the item) |
| a rule for contributors | AGENTS.md |

Do not write dates, counts or status lines that nothing keeps current.
