import { define, makePorts, noIntent, type Ports, type WithTag } from "@mufw/core"
import { Clock, Effect, Option, Schema } from "effect"
import { SeatId } from "../../domain/BoxOffice.ts"

/** How many round trips a meter remembers; the oldest falls off first. */
export const SAMPLES_KEPT = 12

const Pending = Schema.Struct({ seat: SeatId, at: Schema.Number })

export const Model = Schema.Struct({
  pending: Schema.Option(Pending),
  samples: Schema.Array(Schema.Number),
  count: Schema.Int
})
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("Started", { seat: SeatId, at: Schema.Number }),
  Schema.TaggedStruct("Observed", { taken: Schema.Array(SeatId), at: Schema.Number })
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("Start", { seat: SeatId }),
  Schema.TaggedStruct("Observe", { taken: Schema.Array(SeatId) })
])
export type Intent = typeof Intent.Type

export const Representation = Schema.Struct({
  controlState: Schema.Literals(["idle", "timing"]),
  /** Milliseconds of each remembered round trip, oldest first. */
  samples: Schema.Array(Schema.Number),
  last: Schema.Option(Schema.Number),
  mean: Schema.Option(Schema.Number),
  count: Schema.Int
})
export type Representation = typeof Representation.Type

export const initial: Model = { pending: Option.none(), samples: [], count: 0 }


/** A click starts the stopwatch; a second click before the first is answered starts it again. */
export const acceptStarted = (model: Model, proposal: WithTag<Proposal, "Started">): Model => ({
  ...model,
  pending: Option.some({ seat: proposal.seat, at: proposal.at })
})

const finished = (model: Model, elapsed: number): Model => ({
  pending: Option.none(),
  samples: [...model.samples, Math.max(0, elapsed)].slice(-SAMPLES_KEPT),
  count: model.count + 1
})

/** The stopwatch stops at the first representation that shows the clicked seat taken. */
export const acceptObserved = (model: Model, proposal: WithTag<Proposal, "Observed">): Model =>
  Option.match(model.pending, {
    onNone: () => model,
    onSome: (pending) => (proposal.taken.includes(pending.seat) ? finished(model, proposal.at - pending.at) : model)
  })

const meanOf = (samples: ReadonlyArray<number>): Option.Option<number> =>
  samples.length === 0 ? Option.none() : Option.some(samples.reduce((sum, sample) => sum + sample, 0) / samples.length)

export const state = (model: Model): Representation => ({
  controlState: Option.isSome(model.pending) ? "timing" : "idle",
  samples: model.samples,
  last: Option.fromNullishOr(model.samples.at(-1)),
  mean: meanOf(model.samples),
  count: model.count
})

const NANOS_PER_MILLI = 1_000_000

/** The monotonic clock, in milliseconds with a fraction: a round trip in the house is far under one. */
const nowMillis = Clock.monotonicTimeNanos.pipe(Effect.map((nanos) => Number(nanos) / NANOS_PER_MILLI))

export const Meter = define({
  name: "Meter",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  initial,
  acceptors: { Started: acceptStarted, Observed: acceptObserved },
  reactors: [],
  state,
  nap: { idle: noIntent, timing: noIntent },
  actions: {
    Start: ({ seat }) => Effect.map(nowMillis, (at) => ({ _tag: "Started", seat, at }) as const),
    Observe: ({ taken }) => Effect.map(nowMillis, (at) => ({ _tag: "Observed", taken, at }) as const)
  }
})

/** A meter of its own for one stage: a definition under a distinct name, and its ports. */
export interface StageMeter {
  readonly def: typeof Meter
  readonly ports: Ports<typeof Meter>
}

export const meterFor = (stageName: string): StageMeter => {
  const def: typeof Meter = { ...Meter, name: `Meter of ${stageName}` }
  return { def, ports: makePorts(def) }
}
