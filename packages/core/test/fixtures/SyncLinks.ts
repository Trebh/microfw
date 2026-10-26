import { Effect, Latch, Layer, Stream } from "effect"
import { type EventJournal, EventLogRemote } from "effect/eventlog"
import { type LogSubscription, SyncLog } from "../../src/SyncEntry.ts"

/**
 * Wraps a log so that its first subscription ends in a loss after `delivered` entries; every
 * subscription's start sequence is pushed to `subscribedFrom`.
 */
export const lostAfter = <E, R>(log: Layer.Layer<SyncLog, E, R>, delivered: number, subscribedFrom: Array<number>) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const inner = yield* SyncLog
      const lost = new EventLogRemote.EventLogRemoteError({ method: "changes", cause: "connection lost" })
      const cut = (subscription: LogSubscription): LogSubscription => ({
        ...subscription,
        entries: Stream.concat(subscription.entries.pipe(Stream.take(delivered)), Stream.fail(lost))
      })
      const follow = (from: number) =>
        Effect.suspend(() => {
          subscribedFrom.push(from)
          const isFirst = subscribedFrom.length === 1
          return Effect.map(inner.follow(from), (subscription) => isFirst ? cut(subscription) : subscription)
        })
      return SyncLog.of({ ...inner, follow })
    })
  ).pipe(Layer.provide(log))

const lostConnection = new EventLogRemote.EventLogRemoteError({ method: "write", cause: "connection lost" })

/**
 * Wraps a log so that the first append of a `Proposal` fails as a dropped connection does: the
 * entry reaches the log first when `stored` is true, and is lost on the way when it is false.
 */
export const droppedOnFirstProposal = <E, R>(log: Layer.Layer<SyncLog, E, R>, stored: boolean) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const inner = yield* SyncLog
      let dropped = false
      const append = (entry: EventJournal.Entry) =>
        Effect.suspend(() => {
          if (entry.event !== "Proposal" || dropped) return inner.append(entry)
          dropped = true
          const sent = stored ? inner.append(entry) : Effect.void
          return sent.pipe(Effect.andThen(Effect.fail(lostConnection)))
        })
      return SyncLog.of({ ...inner, append })
    })
  ).pipe(Layer.provide(log))

/** The two directions of an instance's link to the log: entries delivered to it, and entries it writes. */
export interface Link {
  readonly deliver: Latch.Latch
  readonly write: Latch.Latch
}

/** Wraps a log so that, while a latch of `link` is closed, the entries it guards are held, not lost. */
export const linkedBy = <E, R>(log: Layer.Layer<SyncLog, E, R>, link: Link) =>
  Layer.effect(
    SyncLog,
    Effect.gen(function*() {
      const inner = yield* SyncLog
      const held = (entries: Stream.Stream<EventJournal.RemoteEntry, any>) =>
        Stream.mapEffect(entries, (entry) => Effect.as(link.deliver.await, entry))
      return SyncLog.of({
        append: (entry) => link.write.await.pipe(Effect.andThen(inner.append(entry))),
        follow: (from) => Effect.map(inner.follow(from), (subscription) => ({ ...subscription, entries: held(subscription.entries) }))
      })
    })
  ).pipe(Layer.provide(log))

export const openLink = Effect.gen(function*() {
  return { deliver: yield* Latch.make(true), write: yield* Latch.make(true) } satisfies Link
})

export const cutOff = (link: Link) => Effect.andThen(link.deliver.close, link.write.close)
