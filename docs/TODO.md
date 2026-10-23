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

### Performance

- [ ] **A browser page ships the synchronisation code it never runs.** `@mufw/core`'s entry
  re-exports `Sync.ts`, `SyncLease.ts` and `SyncStorage.ts`, whose module-level schemas and imports
  of `effect/encoding` and `effect/eventlog` the bundler cannot drop, so a counter page that only
  uses the local loop carries them (`bench:bundle`: the counter page's largest module is
  `effect/encoding/SchemaBinary.js`). Done: a page that imports only the local loop has no module
  of `effect/eventlog` or `effect/encoding` in its bundle, checked by `check:bundle`.
- [ ] **A page shows the step of a click one frame after it.** The intent reaches the render
  through two fiber hops that Effect's default scheduler posts as macrotasks, and Chromium holds a
  macrotask posted from an input event until the next frame, so `bench:browser` measures
  click→DOM at one frame (about 16 ms headless) where the plain uhtml page takes under 1 ms.
  Done: the browser composition roots choose a scheduler that keeps the click's hops in the same
  task without starving input (a microtask scheduler never yields), and `bench:browser` shows
  click→DOM within a millisecond of the uhtml baseline.
- [ ] **History memory is bounded by count, not size.** Each of the `HistoryLimit` records keeps
  its own model; unchanged elements are shared, but every copied collection is held once per
  record, so a model that grows (the auction's `bids`) makes the bound grow with it: `bench:server`
  takes a server past 1 GiB RSS in five seconds of bids. Done: a bound on the retained size as well
  as the count, tested with a model that grows past it.

### Tooling

- [ ] **No build or publish.** Packages export TypeScript sources. Done when a consumer outside the
  workspace needs them: a build to `dist` and `exports` pointing at it.
