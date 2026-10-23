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

### Tooling

- [ ] **No build or publish.** Packages export TypeScript sources. Done when a consumer outside the
  workspace needs them: a build to `dist` and `exports` pointing at it.
