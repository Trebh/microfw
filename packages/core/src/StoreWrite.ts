import { Cause, Effect } from "effect"

/**
 * Runs a store write that nothing may interrupt and that never fails the loop: a failure
 * (`KeyValueStoreError`) or a defect is logged at error level under `what`, and the next write goes on.
 * Shared by `Persistence.ts` and `SyncPersistence.ts`; not part of either entry.
 */
export const writeKept = <E>(write: Effect.Effect<void, E>, what: string, at: number) =>
  Effect.uninterruptible(write).pipe(
    Effect.catch((error) => Effect.logError(what, at, Cause.fail(error))),
    Effect.catchDefect((defect) => Effect.logError(what, at, Cause.die(defect)))
  )
