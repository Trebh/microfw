import { Cause, Clock, Duration, Effect, Random, Ref, Schema } from "effect"
import { Hex } from "effect/encoding"

/** One instance of a synced loop for the lifetime of its layer: 16 random bytes in lowercase hex. */
export const InstanceId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{32}$/, { expected: "32 lowercase hex digits" })),
  Schema.brand("InstanceId")
)
export type InstanceId = typeof InstanceId.Type

/**
 * Who owns automatic actions at one position of the log: the `epoch` of the last claim that won
 * and its `holder`. Epoch 0 with no holder is a log nobody has claimed.
 */
export const LeaseState = Schema.Struct({
  epoch: Schema.Natural,
  holder: Schema.NullOr(InstanceId)
})
export type LeaseState = typeof LeaseState.Type

export const noLease: LeaseState = { epoch: 0, holder: null }

/** The number of a claim that won: 1 for the first holder of a log, then one more for each. */
export const Epoch = Schema.Natural.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))
export type Epoch = typeof Epoch.Type

/**
 * The payload of a `Lease` log entry. The holder writes one with its own epoch to renew; an
 * instance that has seen the holder silent for too long writes one for the next epoch to claim.
 */
export const Lease = Schema.Struct({
  epoch: Epoch,
  holder: InstanceId
})
export type Lease = typeof Lease.Type

/**
 * What a lease entry does to the state it meets. A claim wins only for the epoch after the current
 * one, so of several claims for the same epoch the first in the log wins and the rest are ignored;
 * a renewal counts only from the current holder in the current epoch, so a deposed holder's renewals
 * change nothing.
 */
export type LeaseOutcome = "claimed" | "renewed" | "ignored"

export const leaseOutcome = (state: LeaseState, lease: Lease): LeaseOutcome => {
  if (lease.epoch === state.epoch + 1) return "claimed"
  if (lease.epoch === state.epoch && lease.holder === state.holder) return "renewed"
  return "ignored"
}

/** The state after one lease entry, as every instance computes it from the same entries in the same order. */
export const applyLease = (state: LeaseState, lease: Lease): LeaseState =>
  leaseOutcome(state, lease) === "claimed" ? lease : state

/**
 * Whether a proposal that an automatic action produced under `epoch` is applied at a position of the log where the lease is
 * `state`: only in the epoch the log is in. An earlier epoch has been taken away; a later one names a claim the log has
 * not ordered before the entry, which no holder can have produced, so it is not applied either.
 */
export const isCurrentEpoch = (state: LeaseState, epoch: number): boolean => state.epoch === epoch

/**
 * How long the lease is held without being heard from. The holder appends a renewal every
 * `renewEvery`; an instance that has applied no renewal or claim for `timeout`, by its own clock,
 * claims the next epoch. The timeout is also the time a restarted instance waits before it can
 * take over automatic actions from a holder that is gone.
 */
export interface LeaseTimings {
  readonly renewEvery: Duration.Input
  readonly timeout: Duration.Input
}

export const defaultLeaseTimings: LeaseTimings = { renewEvery: "5 seconds", timeout: "15 seconds" }

/** What one instance knows of the lease: its own identity and the log's lease as far as it has applied. */
export interface LeaseTracker {
  readonly id: InstanceId
  readonly state: Ref.Ref<LeaseState>
  /** The instance's clock, in milliseconds, when it last applied an entry that claimed or renewed. */
  readonly heardAt: Ref.Ref<number>
}

const newInstanceId = Effect.gen(function*() {
  const bytes = new Uint8Array(16)
  for (let index = 0; index < bytes.length; index++) bytes[index] = yield* Random.nextIntBetween(0, 255)
  return InstanceId.make(Hex.encode(bytes))
})

/**
 * A tracker with a fresh identity, so a restarted instance never holds a lease its earlier run
 * did, from `resume` (the lease state a stored checkpoint holds) or from a log nobody has claimed.
 */
export const makeLeaseTracker = (resume: LeaseState | undefined) =>
  Effect.gen(function*() {
    const id = yield* newInstanceId
    const state = yield* Ref.make(resume ?? noLease)
    const heardAt = yield* Ref.make(yield* Clock.currentTimeMillis)
    return { id, state, heardAt } satisfies LeaseTracker
  })

/** What applying an entry did to this instance's ownership. */
export type LeaseChange = "gained" | "lost" | "none"

const ownershipChange = (tracker: LeaseTracker, before: LeaseState, after: LeaseState): LeaseChange => {
  const held = before.holder === tracker.id
  const holds = after.holder === tracker.id
  if (holds && !held) return "gained"
  if (held && !holds) return "lost"
  return "none"
}

/** Applies one lease entry in log order and says whether this instance began or stopped holding the lease. */
export const observeLease = (tracker: LeaseTracker, lease: Lease) =>
  Effect.gen(function*() {
    const before = yield* Ref.get(tracker.state)
    if (leaseOutcome(before, lease) === "ignored") return "none" as const
    yield* Ref.set(tracker.heardAt, yield* Clock.currentTimeMillis)
    const after = applyLease(before, lease)
    yield* Ref.set(tracker.state, after)
    return ownershipChange(tracker, before, after)
  })

/**
 * Replaces the state by the one a snapshot carries and says what that did to this instance's
 * ownership. `heardAt` stays: the snapshot's lease is the lease at the cut, not a sign of life; the
 * entries after it refresh it.
 */
export const installLease = (tracker: LeaseTracker, state: LeaseState) =>
  Effect.gen(function*() {
    const before = yield* Ref.get(tracker.state)
    yield* Ref.set(tracker.state, state)
    return ownershipChange(tracker, before, state)
  })

/** The entry that claims the epoch after the one this instance has applied. */
export const nextClaim = (tracker: LeaseTracker) =>
  Effect.map(Ref.get(tracker.state), (state): Lease => ({ epoch: state.epoch + 1, holder: tracker.id }))

/**
 * One turn of the keeper: the holder renews its epoch; any other instance claims the next epoch when
 * it has applied no lease entry for `timeout`. A failed append is logged and tried again next turn.
 */
const keepOnce = <E>(tracker: LeaseTracker, timeout: Duration.Duration, append: (lease: Lease) => Effect.Effect<void, E>) =>
  Effect.gen(function*() {
    const state = yield* Ref.get(tracker.state)
    if (state.holder === tracker.id) return yield* append({ epoch: state.epoch, holder: tracker.id })
    const silence = (yield* Clock.currentTimeMillis) - (yield* Ref.get(tracker.heardAt))
    if (silence >= Duration.toMillis(timeout)) yield* append(yield* nextClaim(tracker))
  }).pipe(Effect.catch((error) => Effect.logWarning("lease entry not appended", Cause.fail(error))))

/** Renews or claims every `renewEvery`, for as long as the scope it is forked into lives. */
export const keepLease = <E>(
  tracker: LeaseTracker,
  timings: LeaseTimings,
  append: (lease: Lease) => Effect.Effect<void, E>
) => {
  const timeout = Duration.fromInputUnsafe(timings.timeout)
  const turn = keepOnce(tracker, timeout, append)
  return Effect.forever(Effect.sleep(timings.renewEvery).pipe(Effect.andThen(turn)))
}
