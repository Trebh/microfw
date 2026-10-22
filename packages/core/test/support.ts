import { Cause, Effect, Logger, Option, Stream } from "effect"

/** Lets forked fibers (drain, subscribers) run until they suspend. */
export const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true })

/** Collects a stream into a live array, so a test can read what has arrived so far. */
export const collect = <A>(stream: Stream.Stream<A>) =>
  Effect.gen(function*() {
    const seen: Array<A> = []
    yield* Effect.forkScoped(Stream.runForEach(stream, (value) => Effect.sync(() => seen.push(value))))
    yield* settle
    return seen
  })

/** Waits for the first element matching `predicate`. */
export const awaitFirst = <A>(stream: Stream.Stream<A>, predicate: (value: A) => boolean) =>
  stream.pipe(Stream.filter(predicate), Stream.runHead, Effect.map((head) => head.pipe(Option.getOrThrow)))

/** A logger layer that keeps every entry, for asserting what a layer logged. */
export const captureLogs = () => {
  const entries: Array<{ readonly level: string; readonly message: unknown; readonly cause: string }> = []
  const logger = Logger.make((options) => {
    entries.push({ level: options.logLevel, message: options.message, cause: Cause.pretty(options.cause) })
  })
  return { entries, layer: Logger.layer([logger]) }
}
