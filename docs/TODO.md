# TODO

Living document. Add an item when a gap is found; delete it in the change that closes it (the
history lives in git). Each item names where the gap is and what done looks like.

## Known gaps

### Persistence and synchronisation

- [ ] **A checkpoint can be ahead of its log.** A joiner resumes at its stored sequence plus one and
  checks only the log's id. If the host's store lost its newest entries (a power loss with a store
  that does not sync, a directory restored from a backup) the id still matches while the log ends
  before the checkpoint: the joiner waits, and the entries the log appends under sequences it has
  already seen are never delivered to it. Done: a subscription reports the log's last sequence, an
  instance whose checkpoint is past it stops with a typed error, tested over a log truncated after a
  checkpoint was stored.
- [ ] **The event log only grows.** Every proposal, every `Joined` marker and every lease renewal
  stays in the log, which `layerSyncStorage` reads whole into memory when the host starts; with
  automatic actions on, each tick and a renewal every few seconds add one more. Done: a rule that
  cuts the log (a snapshot of the model at a sequence that instances resume from, the entries before
  it dropped), tested with a joiner that starts from the snapshot.
- [ ] **The proposal of a deposed holder is applied if it was appended before the holder heard.** The
  lease stops a holder's automatic actions when it applies the entry that took it away, but an action
  that finished and appended its proposal while the instance was cut off or paused lands in the log
  after the claim and every instance applies it (one tick too many on the auction). Done: a proposal
  produced by an automatic action names the epoch it ran under and instances skip one whose epoch is
  no longer current, tested with a holder cut off from the log whose finished action reaches it after
  the successor's claim.

### View

- [ ] **A keyed list in a view keeps every removed row's node.** `uhtml/keyed`'s `htmlFor` memoizes a
  node per key and uhtml 4 has no way to drop one, so the `<tr>` of a removed or replaced row stays
  referenced for as long as the list's reference does. The js-framework-benchmark run-clear memory is
  9.46 MiB for the µFW entry and 8.41 MiB for the plain uhtml 4 control, against 0.64 MiB for vanilla
  JavaScript (one sample each, `docs/spikes/benchmark-positioning.md`). Done: a keyed list in a
  `@mufw/view-uhtml` view releases the rows it removes, shown by `25_run-clear-memory` (or an
  equivalent heap test) within a stated factor of vanilla JavaScript's.

### Composition

- [ ] **`nest` composes one child into one parent: sibling stateful parts and lists of stateful
  items cannot share one loop, one history and one graph.** `nest(parent, child, options?)`
  (`Nest.ts`) returns a `SamDefinition` whose model is `{ parent, child }`, whose proposals and
  intents are the parent's plus a single wrapper `{ _tag: "Child", proposal }` /
  `{ _tag: "Child", intent }` (`CHILD_TAG`, `nestedSchemas`), and whose acceptors and reactors are
  routed by that wrapper (`parentAcceptor`, `childAcceptor`, `nestedReactors`). The limits:
  - *One child per parent.* There is one `child` slot and one wrapper tag; the wrapper carries no
    address, so a second child has no tag to travel under.
  - *A nested definition cannot be a parent.* `assertNoChildTag` reads the tags of the parent's
    proposal and intent schemas and `nest` throws when `Child` is one of them, which a `nest` result
    always is (`Nest.test.ts`, "throws when a nested definition is the parent"). The chain
    `nest(A, nest(B, C))` works and routes a grandchild proposal through two wrappers
    (`Child/Child/Inc`), but that is a hierarchy, not siblings: `C` is reachable only through `B`,
    and `nest(nest(A, B), C)` throws. Two stateful children of one parent have no encoding.
  - *No collection.* The model has a fixed shape, so there is no keyed or runtime-sized set of child
    instances (N rows each with its own edit state, added and removed while the loop runs); nothing
    in a proposal names which instance it is for.
  - *Cross-side hooks are per side, not per instance.* `Forwarding.toParent` receives the unwrapped
    child proposal and `toChild` the parent proposal, both without the model, and each returns at
    most one proposal for the single other side (`forwardToParent`, `forwardToChild`); with several
    children neither knows which child a proposal came from or goes to. The combined
    `controlState` is a function of one parent and one child representation, with `controlStates`
    listed by hand (`Playhouse` builds the product with `flatMap`).
  - *`nap` is parent first, then the one child* (`nestedNap`): it returns a single intent, so with
    several children one child's automatic intent starves the others until it stops being offered.
    `nestedIntentKey` keys a child intent `Child/` plus the child's own key, so the same kind of
    intent from two instances of one child shares a key and the loop's drain (`Layers.ts`) skips
    the second while the first is in flight.
  - *Labels, events and tests read the wrapper.* `proposalLabel` renders `Child/Inc`, with no
    instance in it; `toXStateDefinition` keys transitions by `edge.proposal._tag`, so every child
    proposal is the one event `Child`; `Nest.paths.test.ts` rebuilds the wrapped intent from the
    step by hand (`intentFor`).
  - *The result's type is asserted, not derived.* `nest` ends in `as Nested<PD, CD, S>` because
    TypeScript cannot compose the schemas over generic `PD` and `CD`.

  The alternative today is islands: one definition per part, each with its own loop and history,
  joined by `layerForward` (`Forward.ts`; the auction's wallet, `walletOwner.ts`). That splits the
  history, so `travelTo` rewinds one part only and no step spans both; it splits the graph, so no
  path test covers a state of the parts together; and it is asynchronous, so the other part changes
  in a later step. A form with several independent sections, a wizard step with two sub-widgets and
  a list of editable rows are all this shape.

  To design, each with the rule written in `docs/architecture/sam-loop.md`: how a proposal and an
  intent address one instance (a tag per static slot, or a keyed wrapper `{ _tag: "Child", key, … }`);
  whether static siblings and keyed collections are one mechanism or two; how instances are created
  and removed (proposals of the parent, with the collection in the model) and what happens to a
  proposal for an instance that is gone; the shapes of the model and the representation (record of
  slots, `Record<key, …>`, `ReadonlyArray`) and the schemas that compose them, including a
  collection's `controlState`; how acceptors and reactors reach each instance and what
  `toParent`/`toChild` receive (the instance's key and the model, or the proposal only); which
  automatic intent `nap` offers when several instances have one, and whether it may offer more than
  one; the `intentKey` per instance, so that two instances' actions run concurrently and one
  instance's repeated intent is still skipped; the history label with the instance in it
  (`proposalLabel`, which devtools and the showcase read); how large the explored graph may grow
  (with a combined `controlState` the nodes are the product of the children's states, and
  `exploreGraph` throws past `limit`, default 1 000): a projection to a node key (`key`), a finer
  `serialize` for the instance under test, symmetry reduction across interchangeable instances, or
  a bound on N, and what a path test can cover once it is chosen; and whether `nest` is generalised
  (with `Child` kept for the one-child case) or a new combinator is added next to it.

  Done: a definition with two sibling stateful children and one with a keyed collection of one child
  run on one loop with one history, each step changing the parts it names in a single record;
  `exploreGraph` covers each within `limit` and `createTestModel` runs path tests over them, with a
  test that two instances' automatic actions run concurrently and one instance's are not repeated;
  `proposalLabel` names the instance; the rules above, and the limit that remains, are in
  `docs/architecture/sam-loop.md`.

### Tooling

- [ ] **No build or publish.** Packages export TypeScript sources. Done when a consumer outside the
  workspace needs them: a build to `dist` and `exports` pointing at it.

### Research

- [ ] **Whether coding agents do better or worse with µFW than with React is a guess, not a
  measurement.** The hypothesis has three parts. Agents are better with µFW at moving a rule
  between client and server and at keeping state synchronised, because a placement is a layer, the
  step is pure, every cut point is a schema, and `@mufw/test` derives the oracle from the
  definition. They are worse at first-attempt API correctness, because model training data is
  dominated by React and Vue and by Effect 3, while µFW and Effect 4 are new (the "prior pull";
  `AGENTS.md` already tells agents not to rely on Effect 3 knowledge). And they are worst at a task
  that needs a list of stateful items, because `nest` composes exactly one child (see the `nest`
  item under `### Composition`), so a list falls back to islands. Nothing in the repository
  measures any of it: the committed baselines (`performance.md`) are bundle, startup, step and
  server costs, and the tests in `@mufw/test` (`presentDriver`, `intentDriver`, `domDriver`) drive
  µFW's own ports and mount, so they cannot score a React page. This item depends on the `nest`
  item: until it is closed the list task runs on islands, and the report says so. Proposed
  design, to be settled while building it:
  - *Baseline.* A React implementation of the same auction and wallet: current React with
    TypeScript, state in `useReducer` and hooks as a React developer writes it, a Vitest and
    Testing Library suite of its own, no state-machine library unless a task needs one, no
    strawman. It has the same markup and `style.css`, and its server implements the same contract
    as `examples/auction` (the JSON frames of its RPC, written down apart from Effect so a server
    that does not use Effect can implement them). It covers the placements the tasks exercise, and
    the report says which. It is built and reviewed, and frozen with the harness, before the first
    trial; neither side is edited while the study runs. Its credit check, session handling and
    wallet release follow the behaviour of `examples/auction`, not its structure.
  - *Tasks.* Each is a prompt plus a hidden acceptance test that drives only the rendered page
    (Playwright, as `scripts/bench-browser.ts` already does) and the server contract (plain
    `fetch` and websocket frames), never `@mufw/test` and never a framework's test utilities.
    The test is copied in after the trial, so the agent never sees it. At least: add a business
    rule (a minimum increment, say); move a rule from client to server (the credit check
    starting in the browser, as `creditCheckPermissive` does); add ephemeral UI state (a
    collapsible panel or a draft that survives a rerender, kept out of the model where the
    framework allows); add a list of stateful items (bid rows each with an editor open or
    closed; depends on the `nest` item, and while it is open the µFW side runs with islands,
    which the report records); fix a seeded state-sync bug (a defect planted in each baseline
    that produces the same visible symptom, such as a wallet that keeps a reservation after the
    bidder is outbid); and a change that crosses the domain, the wire, the view and the wallet
    (a second lot, say). The seeded defects and every starting commit are equivalent in what a
    user sees, not in code.
  - *Controls.* One agent harness at a pinned version; more than one model, each pinned; one
    prompt template, differing only in the framework's name and the path of its docs; a repo-provided
    instruction file for React of the same size and kind as `AGENTS.md` (commands, architecture
    rules, testing rules), written before the trials, with the same byte budget for the docs an
    agent may read on either side; temperature and seed fixed where the harness exposes them and
    recorded where it does not; a fresh checkout and no memory across trials; several trials per
    task, model and framework; the order of trials randomised and logged. The hidden tests pass or
    fail mechanically, which blinds that score; defect classification and readability are scored
    by reviewers who do not know the per-task hypothesis, with the limit stated that a diff shows
    its framework. Contamination is part of what is measured, not noise: React is in the training
    data and µFW is not, so neither side is given extra docs to even it out, and the models'
    published training cut-offs are recorded beside the results.
  - *Metrics.* Per task, model and framework: hidden-test pass rate at the first attempt and at
    k attempts; iterations to green (runs of the visible tests and the typecheck before the visible
    suite passes); tokens in and out; distinct files read; wall time; diff size (files touched and
    lines changed, generated files and lockfiles excluded). Each failing or repaired attempt is
    classified by a rubric written before the trials as API misuse (a symbol that does not exist,
    an Effect 3 idiom, a wrong signature), state synchronisation (a model that diverges between
    client, server or derived views, a stale or lost update) or placement (a rule on the wrong
    side, a client value trusted by the server). Secondary: human review time and a readability
    score on a fixed scale. The rule that turns the figures into "confirmed" or "refuted" for a
    task (a minimum difference in pass rate and the interval it must exclude) is written down
    before the first trial.
  - *Where it lives.* A directory of its own in the workspace (`research/agentic`, added to
    `pnpm-workspace.yaml`) holding the React baseline, the task prompts, the hidden tests, the
    rubric and a runner script (`pnpm --filter @mufw/research-agentic run`); results committed under
    the harness version that produced them; and `docs/architecture/agentic.md`, which reports the
    figures the way `performance.md` does: the command that regenerates each table, the machine,
    harness and model versions, the plain baseline in a column of its own, "none measured" where
    there is none, "derived" and "inference" marks, and the limits of each figure. `README.md`,
    `AGENTS.md` (packages, commands) and `docs/ARCHITECTURE.md` (the page index) change with it.

  Done: the harness, the React baseline and the hidden tests exist and are frozen before a run; one
  run produces the figures above for µFW and for React on every task; and
  `docs/architecture/agentic.md` reports each part of the hypothesis as confirmed or refuted per
  task, by the rule fixed beforehand, with the state of the `nest` item at the time of the run
  (open: the list task ran on islands; closed: it ran on `nest`) stated beside the list task.
