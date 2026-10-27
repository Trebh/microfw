# TODO

Living document. Add an item when a gap is found; delete it in the change that closes it (the
history lives in git). Each item names where the gap is and what done looks like.

## Known gaps

### Persistence and synchronisation

- [ ] **A log restored from a backup and grown past a checkpoint is not noticed.** An instance stops
  (`SyncLogBehind`) when its log ends before its checkpoint, but a log that lost entries and then
  appended until it is as long again holds other entries under sequences the instance applied, and the
  instance keeps going on a model the log does not explain. Done: a checkpoint names the entry at its
  sequence, a subscription from that sequence delivers that entry or the instance stops with a typed
  error, tested over a log restored to an earlier state and grown past a checkpoint.
- [ ] **A writer's resend of an entry cut away long ago is stored and applied again.** A cut keeps the
  ids of the last `retain` entries it stands for (`SyncStorage.ts`, `appliedAfter`), so the log
  recognises a resend of one of them as the duplicate it is; an entry cut away more than `retain`
  entries before its writer, cut off from the log in between, sends it again is stored under a new
  sequence and applied twice. Done: a writer's resend is recognised however long it was cut off, or
  refused with a typed failure, tested with a writer cut off across more than one window.

### Research

The three items below are one study in stages; each stage starts when the one before it is done.
Its conclusions are about the µFW stack as a whole (SAM, Effect 4, layers, schemas, `AGENTS.md`,
`@mufw/test`): no arm isolates one of them, and the report says so.

- [ ] **Stage 0: whether agents get µFW's API right at the first attempt is not measured.** The
  "prior pull" hypothesis: model training data is dominated by React, Vue and Effect 3, while µFW
  and Effect 4 are new, so first attempts misuse the API (`AGENTS.md` already tells agents not to
  rely on Effect 3 knowledge). It needs no React baseline. Plan:
  - *Harness.* A repository of its own, not this workspace, holding the runner, the task prompts,
    the hidden checks, the rubric and the raw results. The runner builds each trial's tree by
    exporting this repository at a frozen tag with the `### Research` section of `docs/TODO.md`
    and `docs/architecture/agentic.md` removed, so an agent sees neither the hypothesis nor the
    checks; the trial's sandbox cannot reach the harness repository. One agent harness at a pinned
    version, each model a pinned snapshot, a fresh tree and no memory per trial, temperature and
    seed fixed where the harness exposes them and recorded where it does not, trial order
    randomised and logged.
  - *Tasks.* 15 to 20 small changes, each a prompt plus a hidden check (the typecheck and a hidden
    vitest file copied in after the trial): add a proposal with its acceptor and `nap` entry, add
    an intent whose action uses a port, swap a placement layer at a composition root, add a slot
    and a keyed collection with `compose`, write a path test with `createTestModel`, refine a field
    with a schema instead of an `if`.
  - *Rubric.* Written before the trials: a nonexistent symbol, an Effect 3 idiom, a wrong
    signature, a broken µFW convention (`AGENTS.md`). Two raters, Cohen's κ of at least 0.7 on a
    calibration set before scoring, a third rater settles disagreements.

  Done: two or more models, ten trials per task and model; `docs/architecture/agentic.md` reports
  the first-attempt pass rate per task and the errors per rubric class, each class traced to the
  document that could have prevented it.

- [ ] **Stage 1: the comparative study has no React baseline, behaviour contract or pilot.**
  Plan:
  - *Baseline.* A React implementation of the auction and the wallet, in a repository of its own:
    current React with TypeScript, state in `useReducer` and hooks, a Vitest and Testing Library
    suite, the same markup and `style.css`, and a server in whatever shape a React developer
    chooses. Its credit check, session handling and wallet release follow the behaviour of
    `examples/auction`, not its structure. An agent builds it from a written behaviour spec, with
    a model that is not one of the trial models (recorded, since a baseline in a trial model's
    own style favours that model). A human React developer reviews it against a checklist written
    beforehand: idiomatic, no strawman, no imitation of µFW's structure. Its instruction file is
    of the same kind and size as `AGENTS.md` (commands, architecture rules, testing rules).
  - *Behaviour contract.* Hidden tests drive the rendered page (Playwright) and a set of domain
    operations, never wire frames: start a server from a seeded state with automatic actions off;
    open a session as a bidder; place a bid as a session; read the auction's visible state (bids,
    phase, last rejection); and the forgery probes, a request that applies a result directly and a
    bid over the credit limit sent without the page. Each side has an adapter in the harness that
    maps the operations to its own server. The µFW adapter uses the server as it is: a seeded
    `MUFW_STORE`, `MUFW_AUTO_ACTIONS=off`, the production `MUFW_RPCS` (so `Present` is not
    served), the `x-session-token` header, `Submit` over `/sam/auction` and `Representations` over
    `/sam/auction/http`; no framework code changes for it. A parity suite of the operations passes
    on both sides at their starting commits before anything is frozen. A task that changes the
    wire (a second lot) is accepted through the page only, since no adapter can be written for a
    shape the agent chooses.
  - *Tasks.* Each with the hypothesis it tests: add a business rule, a minimum increment (control:
    no direction predicted); move the credit check from the browser to the server, accepted by the
    forgery probe (placement: µFW better); fix a seeded state-sync defect with the same visible
    symptom on both sides, a wallet that keeps a reservation after the bidder is outbid (sync: µFW
    better); add bid rows each with an editor open or closed (stateful list: µFW worse, a keyed
    collection in `compose` has no precedent in training data); add ephemeral UI state, a
    collapsible panel or a draft that survives a rerender (µFW worse: it has no component-local
    state); add a second lot across the domain, the wire, the view and the wallet (exploratory, no
    direction predicted). The seeded defects and the starting commits are equivalent in what a
    user sees, not in code. Each side's trial tree is its own repository at a frozen tag; a trial
    never sees the other side.
  - *Pilot.* The first two tasks, one model, ten trials per side, through the Stage 0 harness.

  Done: both baselines frozen with a green parity suite; the pilot ran end to end, an agent's
  attempt to read the harness or the other side fails, and the pilot's pass rates, tokens and wall
  time per trial are recorded for Stage 2's sample size.

- [ ] **Stage 2: whether coding agents do better or worse with µFW than with React is a guess, not a
  measurement.** Plan:
  - *Pre-registration.* A document committed to the harness before the first trial: the
    hypothesis and direction per task (Stage 1); the primary endpoint, the hidden-test pass rate at
    the first attempt; the analysis, a mixed-effects logistic regression of pass on framework by
    task with a random intercept per model, a per-task difference with its 95% interval, Holm's
    correction across the tasks with a direction; the minimum difference that matters; three
    outcomes per task: confirmed (the interval excludes zero in the predicted direction and the
    estimate reaches the minimum), refuted (the interval excludes zero in the other direction, or
    lies below the minimum), inconclusive (anything else); the trials per task, model and framework
    that reach 80% power for the minimum at the pilot's pass rates, and a budget cap.
  - *Run.* Every Stage 1 task, two or more pinned models, trials of the two sides interleaved in a
    randomised, logged order so model drift falls on both. Secondary figures, descriptive only:
    pass rate at k attempts, iterations to green, tokens in and out, distinct files read, wall
    time, diff size (generated files and lockfiles excluded), human review time, and each failing
    or repaired attempt classified by the Stage 0 rubric extended with state synchronisation (a
    model that diverges between client, server or derived views, a stale or lost update) and
    placement (a rule on the wrong side, a client value trusted by the server).
  - *Contamination.* Part of what is measured: neither side gets extra docs to even it out; the
    models' published training cut-offs and the frozen tags are recorded beside the results, which
    hold for those tags only.

  Done: `docs/architecture/agentic.md` reports each task as confirmed, refuted or inconclusive by
  the pre-registered rule, with the secondary figures, the versions and the limits of each figure,
  the way `performance.md` reports costs; `docs/ARCHITECTURE.md` lists the page.
