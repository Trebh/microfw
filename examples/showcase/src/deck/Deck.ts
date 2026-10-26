import { define, makePorts, type Nap, noIntent, type WithTag } from "@mufw/core"
import { Effect, Option, Schema } from "effect"
import type { ActScript } from "../act.ts"

/** One act of the program: how many cues it has and how long each is read, in milliseconds. */
export const ProgramAct = Schema.Struct({
  id: Schema.String,
  cues: Schema.Int,
  readings: Schema.Array(Schema.Int)
})
export type ProgramAct = typeof ProgramAct.Type

export const Model = Schema.Struct({
  acts: Schema.Array(ProgramAct),
  actIndex: Schema.Int,
  cue: Schema.Int,
  autoplay: Schema.Boolean
})
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("Advanced", {}),
  Schema.TaggedStruct("Retreated", {}),
  Schema.TaggedStruct("Jumped", { actId: Schema.String, cue: Schema.Int }),
  Schema.TaggedStruct("AutoplayToggled", {}),
  Schema.TaggedStruct("CueElapsed", { act: Schema.String, cue: Schema.Int }),
  Schema.TaggedStruct("Interrupted", {})
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("Next", {}),
  Schema.TaggedStruct("Previous", {}),
  Schema.TaggedStruct("GoTo", { actId: Schema.String, cue: Schema.Int }),
  Schema.TaggedStruct("ToggleAutoplay", {}),
  Schema.TaggedStruct("Interrupt", {}),
  Schema.TaggedStruct("AwaitCue", { act: Schema.String, cue: Schema.Int, millis: Schema.Int })
])
export type Intent = typeof Intent.Type

export const Representation = Schema.Struct({
  controlState: Schema.Literals(["presenting", "autoplay", "ended"]),
  actId: Schema.String,
  actIndex: Schema.Int,
  cue: Schema.Int,
  cueCount: Schema.Int,
  actCount: Schema.Int,
  /** 0 at the first cue of the first act, 1 at the last cue of the last act. */
  progress: Schema.Number,
  autoplay: Schema.Boolean,
  /** How long the current cue is read before autoplay moves on. */
  readingMillis: Schema.Int
})
export type Representation = typeof Representation.Type

/** What a cue without a measured line is read for. */
export const DEFAULT_READING_MILLIS = 6000

const MIN_READING_MILLIS = 3500
const MAX_READING_MILLIS = 14_000
const MILLIS_PER_CHARACTER = 55

/** A line is read at a steady pace, bounded so a stage direction is not skipped and a speech does not stall. */
export const readingMillis = (line: string): number =>
  Math.min(MAX_READING_MILLIS, MIN_READING_MILLIS + MILLIS_PER_CHARACTER * line.length)

/** The program a deck plays, from the acts' scripts in running order. */
export const programOf = (scripts: ReadonlyArray<ActScript>): ReadonlyArray<ProgramAct> =>
  scripts.map((script) => ({
    id: script.id,
    cues: script.cues.length,
    readings: script.cues.map((cue) => readingMillis(cue.line))
  }))

/** The deck at the start of `program`, or at the first cue of the act `hash` names (`#loop`); unknown or empty means the first act. */
export const initialModel = (program: ReadonlyArray<ProgramAct>, hash: string): Model => {
  const named = program.findIndex((act) => act.id === hash.replace(/^#/, ""))
  return { acts: program, actIndex: Math.max(0, named), cue: 0, autoplay: false }
}

const EMPTY_ACT: ProgramAct = { id: "", cues: 1, readings: [] }

export const currentAct = (model: Model): ProgramAct => model.acts[model.actIndex] ?? EMPTY_ACT

const lastCueOf = (act: ProgramAct): number => Math.max(0, act.cues - 1)

const isLastAct = (model: Model): boolean => model.actIndex >= model.acts.length - 1

const isAtEnd = (model: Model): boolean => isLastAct(model) && model.cue >= lastCueOf(currentAct(model))

/** One cue forward; at an act's last cue, the next act's first; at the very end, nothing. */
export const advance = (model: Model): Model => {
  if (model.cue < lastCueOf(currentAct(model))) return { ...model, cue: model.cue + 1 }
  if (isLastAct(model)) return model
  return { ...model, actIndex: model.actIndex + 1, cue: 0 }
}

/** One cue back; at an act's first cue, the previous act's last; at the very start, nothing. */
export const retreat = (model: Model): Model => {
  if (model.cue > 0) return { ...model, cue: model.cue - 1 }
  const previous = model.acts[model.actIndex - 1]
  if (previous === undefined) return model
  return { ...model, actIndex: model.actIndex - 1, cue: lastCueOf(previous) }
}

/** The named act at `cue`, clamped to the act's cues; an unknown act leaves the deck where it is. */
export const jump = (model: Model, actId: string, cue: number): Model => {
  const actIndex = model.acts.findIndex((act) => act.id === actId)
  const target = model.acts[actIndex]
  if (target === undefined) return model
  return { ...model, actIndex, cue: Math.min(lastCueOf(target), Math.max(0, cue)) }
}


export const acceptAdvanced = (model: Model): Model => advance(model)

export const acceptRetreated = (model: Model): Model => retreat(model)

export const acceptJumped = (model: Model, proposal: WithTag<Proposal, "Jumped">): Model =>
  jump(model, proposal.actId, proposal.cue)

export const acceptAutoplayToggled = (model: Model): Model => ({ ...model, autoplay: !model.autoplay })

/** A reading that ends after the audience moved on, or after autoplay stopped, changes nothing. */
export const acceptCueElapsed = (model: Model, proposal: WithTag<Proposal, "CueElapsed">): Model => {
  const isStillUp = currentAct(model).id === proposal.act && model.cue === proposal.cue
  return model.autoplay && isStillUp ? advance(model) : model
}

export const acceptInterrupted = (model: Model): Model => ({ ...model, autoplay: false })

const controlStateOf = (model: Model): Representation["controlState"] => {
  if (isAtEnd(model)) return "ended"
  return model.autoplay ? "autoplay" : "presenting"
}

const cuesBefore = (model: Model): number =>
  model.acts.slice(0, model.actIndex).reduce((total, act) => total + act.cues, 0)

const progressOf = (model: Model): number => {
  const total = model.acts.reduce((sum, act) => sum + act.cues, 0)
  return total <= 1 ? 0 : (cuesBefore(model) + model.cue) / (total - 1)
}

export const state = (model: Model): Representation => {
  const act = currentAct(model)
  return {
    controlState: controlStateOf(model),
    actId: act.id,
    actIndex: model.actIndex,
    cue: model.cue,
    cueCount: act.cues,
    actCount: model.acts.length,
    progress: progressOf(model),
    autoplay: model.autoplay,
    readingMillis: act.readings[model.cue] ?? DEFAULT_READING_MILLIS
  }
}

const whisperReading = (representation: Representation): Option.Option<Intent> =>
  Option.some({
    _tag: "AwaitCue",
    act: representation.actId,
    cue: representation.cue,
    millis: representation.readingMillis
  })

/** The prompter: while the show runs by itself, whisper the reading of the cue that is up. */
const nap: Nap<Representation, Intent> = {
  presenting: noIntent,
  autoplay: whisperReading,
  ended: noIntent
}

export const Deck = define({
  name: "Deck",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  initial: { acts: [], actIndex: 0, cue: 0, autoplay: false },
  acceptors: {
    Advanced: acceptAdvanced,
    Retreated: acceptRetreated,
    Jumped: acceptJumped,
    AutoplayToggled: acceptAutoplayToggled,
    CueElapsed: acceptCueElapsed,
    Interrupted: acceptInterrupted
  },
  reactors: [],
  state,
  nap,
  // A reading is keyed by the cue it waits on, so moving on by hand does not skip the next cue's reading.
  intentKey: (intent) => (intent._tag === "AwaitCue" ? `AwaitCue:${intent.act}:${intent.cue}` : intent._tag),
  actions: {
    Next: () => Effect.succeed({ _tag: "Advanced" }),
    Previous: () => Effect.succeed({ _tag: "Retreated" }),
    GoTo: ({ actId, cue }) => Effect.succeed({ _tag: "Jumped", actId, cue }),
    ToggleAutoplay: () => Effect.succeed({ _tag: "AutoplayToggled" }),
    Interrupt: () => Effect.succeed({ _tag: "Interrupted" }),
    AwaitCue: ({ act, cue, millis }) =>
      Effect.sleep(millis).pipe(Effect.as({ _tag: "CueElapsed", act, cue } as const))
  }
})

export const DeckPorts = makePorts(Deck)
