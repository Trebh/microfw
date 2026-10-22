# AGENTS.md

Instructions for anyone — human or coding agent — changing this repository. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before touching a package.

## Project

µFW is a SAM-pattern framework on Effect 4. A SAM definition is the domain; its ports are Effect
services; local and remote implementations are layers; the example (`examples/auction`) runs one
definition in four browser/server placements.

```
packages/core        @mufw/core        definition, pure step, ports, local layers, graph
packages/rpc         @mufw/rpc         wire contract and remote adapters (no transport)
packages/view-uhtml  @mufw/view-uhtml  mounts a pure uhtml v4 view
packages/devtools    @mufw/devtools    time-travel panel, Stately adapter
packages/test        @mufw/test        model-based path testing
examples/auction     @mufw/example-auction
docs/                ARCHITECTURE.md, architecture/*.md, TODO.md
```

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | install; pnpm 12 enforces a minimum release age, so a just-published version is refused |
| `pnpm typecheck` | `tsc --noEmit` in every package, one at a time |
| `pnpm test` | vitest over `packages/*/test` and `examples/*/test` |
| `pnpm dev:server` | demo server on :3001 serving every RPC (`MUFW_AUTO_ACTIONS=off` disables automatic actions) |
| `pnpm start:server` | server with the production defaults (`MUFW_RPCS=Submit,Representations,History`) |
| `pnpm dev:client` | vite on :5173: one page per deployment plus the demo page |
| `pnpm build:client` | one `vite build` per deployment into `examples/auction/dist/<deployment>`, then `check:bundle` |
| `pnpm --filter @mufw/example-auction test:live` | replays the path tests against a running server |

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
  module of `src/client/placements/`, `server.ts`, `test/live.ts`), by choosing layers. Only the demo
  page picks a placement at runtime; never let a visitor choose what the server trusts. If moving a part between client and server needs a change outside the
  composition root, the design is wrong: fix the port, not the call site.

### Dependency injection and inversion

- Depend on the port, never on an implementation: `yield* ports.ModelPort`, `yield* CreditCheck`.
- Provide implementations only with `Layer`s, and only at the composition root or in a test.
- A service a domain action needs (`CreditCheck`) is a port declared in `src/domain/`; its
  implementations are adapters in their own modules under `src/adapters/`, so a bundle only
  contains the adapters its composition root imports. Never put a server-side implementation (and
  its secrets) in the module that declares the port.
- A server serves only the RPCs its deployment needs (`MUFW_RPCS`); it serves `Present` only to
  trusted clients, since it applies any proposal it receives.
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
  (`Schema.TaggedError`). A lost transport or an impossible state is a defect.
- Known gaps are listed in [docs/TODO.md](docs/TODO.md); do not add new ones.

### Effect, idiomatically

- `Effect.gen` for inline code; `Effect.fn("name")` for reusable traced functions,
  `Effect.fnUntraced` in library hot paths. Do not wrap an `Effect.gen` in a function that only
  returns it.
- Services with `Context.Service`, wiring with `Layer` (`Layer.effect`, `Layer.effectContext`,
  `Layer.effectDiscard` for background fibers), configuration with `Config` and
  `Context.Reference` for defaults (`AutoActions`).
- Errors in the error channel with `Schema.TaggedError`, handled with `Effect.catchTag`; never
  `throw` inside effectful code. Pure functions may throw only for authoring bugs (the graph limit).
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
| Process entry point | `runPage` in `examples/auction/src/client/app.ts`, `server.ts`, `test/live.ts` |
| DOM event handler | `layerMount` dispatch, `layerPanel` click, through a `FiberSet.makeRuntime` runner captured from the layer |
| Test harness | `it.effect` / `layer` from `@effect/vitest` |

Anywhere else, return the effect and let the caller compose it. Do not convert an `Effect` to a
`Promise` and back mid-stack; do not `Effect.orDie` a typed error to make a signature simpler — only
transport loss is turned into a defect, in `@mufw/rpc`.

## SAM rules

- Acceptors, reactors, `state` and `nap` are pure and synchronous: no `Effect`, no clock, no I/O,
  no randomness. Put anything effectful in an action and pass its result in the proposal.
- Each acceptor handles its own tags and returns the model unchanged otherwise.
- The representation always carries `controlState`; `controlStates` lists every value it can take.
- `nap` returns at most one intent; automatic intents of a tag already in flight are skipped.
- Model mutation happens only in `layerModelLocal`, under its permit.

## Testing rules

- `@effect/vitest` (`it.effect`, `assert`), `TestClock` from `effect/testing` for time.
- One behaviour per test, a name that states the rule, Arrange–Act–Assert, literal expectations
  worked out by hand, no `if`/`for` in a test body.
- Domain logic is tested as pure functions with literal models (`examples/auction/test/Auction.test.ts`).
- Behaviour across states is tested with `@mufw/test`: a test model next to the definition, run
  with `AutoActions` false over the local loop and over `Rpc.layerClientTest`.
- Substitute dependencies with layers at real boundaries (transport, credit check, clock); never
  mock the model or the ports' internals.
- The shared counter fixture is `packages/core/test/fixtures/Counter.ts`.
- A test must be able to fail: when adding one for a rule, break the rule once and watch it fail.

## Code conventions

- TypeScript strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`; import with the `.ts`
  extension; type-only imports with `import type`.
- `define(schemas)(behaviour)`: keep the two calls, they are what types the behaviour's literals.
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
| a gap found or closed | docs/TODO.md (add it, or delete the item) |
| a rule for contributors | AGENTS.md |

Do not write dates, counts or status lines that nothing keeps current.
