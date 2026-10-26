import { define, makePorts, type Nap, noIntent, type WithTag } from "@mufw/core"
import type { PathFailure } from "@mufw/test"
import { Effect, Option, Schema } from "effect"
import { callSheet } from "./sheet.ts"
import { rehearsePath, resetUnderstudies, UnderstudyName } from "./understudy.ts"

/** What the test runner reports of a failed path: the fields of `PathFailure`. */
export const Failure = Schema.Struct({
  target: Schema.String,
  stepIndex: Schema.Int,
  expected: Schema.String,
  actual: Schema.String,
  message: Schema.String
})
export type Failure = typeof Failure.Type

const Result = Schema.Union([
  Schema.TaggedStruct("Pending", {}),
  Schema.TaggedStruct("Passed", {}),
  Schema.TaggedStruct("Failed", { failure: Failure })
])
type Result = typeof Result.Type

/** One result per line of the call sheet, in the sheet's order. */
export const Model = Schema.Struct({
  phase: Schema.Literals(["idle", "rehearsing", "done"]),
  understudy: UnderstudyName,
  /** Counts the rehearsals called, so a path that finishes after its rehearsal was replaced is ignored. */
  round: Schema.Int,
  results: Schema.Array(Result)
})
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("Called", { understudy: UnderstudyName }),
  Schema.TaggedStruct("Settled", { understudy: UnderstudyName }),
  Schema.TaggedStruct("Dismissed", {}),
  Schema.TaggedStruct("PathPassed", { round: Schema.Int, index: Schema.Int }),
  Schema.TaggedStruct("PathFailed", { round: Schema.Int, index: Schema.Int, failure: Failure })
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("Rehearse", { understudy: UnderstudyName }),
  Schema.TaggedStruct("Settle", { understudy: UnderstudyName }),
  Schema.TaggedStruct("Dismiss", {}),
  Schema.TaggedStruct("RunPath", { round: Schema.Int, index: Schema.Int, understudy: UnderstudyName })
])
export type Intent = typeof Intent.Type

export const Line = Schema.Struct({
  index: Schema.Int,
  status: Schema.Literals(["pending", "running", "passed", "failed"]),
  failure: Schema.Option(Failure)
})
export type Line = typeof Line.Type

export const Representation = Schema.Struct({
  controlState: Schema.Literals(["idle", "rehearsing", "clean", "flawed"]),
  understudy: UnderstudyName,
  round: Schema.Int,
  lines: Schema.Array(Line),
  total: Schema.Int,
  passed: Schema.Int,
  failed: Schema.Int
})
export type Representation = typeof Representation.Type

const pending: Result = { _tag: "Pending" }

export const initial: Model = {
  phase: "idle",
  understudy: "honest",
  round: 0,
  results: callSheet.map(() => pending)
}

const begin = (model: Model, understudy: UnderstudyName): Model => ({
  phase: "rehearsing",
  understudy,
  round: model.round + 1,
  results: model.results.map(() => pending)
})


export const acceptCalled = (model: Model, proposal: WithTag<Proposal, "Called">): Model => begin(model, proposal.understudy)

/** A rehearsal already on this understudy, running or finished, is left as it is. */
export const acceptSettled = (model: Model, proposal: WithTag<Proposal, "Settled">): Model => {
  const alreadyThere = model.phase !== "idle" && model.understudy === proposal.understudy
  return alreadyThere ? model : begin(model, proposal.understudy)
}

export const acceptDismissed = (model: Model): Model => ({ ...begin(model, "honest"), phase: "idle" })

/** A result counts only for the rehearsal it was run for, and only for a path still waiting. */
const recorded = (model: Model, round: number, index: number, result: Result): Model => {
  const waiting = model.results[index]?._tag === "Pending"
  if (model.phase !== "rehearsing" || round !== model.round || !waiting) return model
  const results = model.results.map((existing, at) => (at === index ? result : existing))
  const finished = results.every((existing) => existing._tag !== "Pending")
  return { ...model, phase: finished ? "done" : "rehearsing", results }
}

export const acceptPathPassed = (model: Model, proposal: WithTag<Proposal, "PathPassed">): Model =>
  recorded(model, proposal.round, proposal.index, { _tag: "Passed" })

export const acceptPathFailed = (model: Model, proposal: WithTag<Proposal, "PathFailed">): Model =>
  recorded(model, proposal.round, proposal.index, { _tag: "Failed", failure: proposal.failure })

const lineOf = (result: Result, index: number, runningIndex: number): Line => {
  switch (result._tag) {
    case "Pending":
      return { index, status: index === runningIndex ? "running" : "pending", failure: Option.none() }
    case "Passed":
      return { index, status: "passed", failure: Option.none() }
    case "Failed":
      return { index, status: "failed", failure: Option.some(result.failure) }
  }
}

const controlStateOf = (model: Model, failed: number): Representation["controlState"] => {
  if (model.phase === "idle") return "idle"
  if (model.phase === "rehearsing") return "rehearsing"
  return failed > 0 ? "flawed" : "clean"
}

const countOf = (lines: ReadonlyArray<Line>, status: Line["status"]): number =>
  lines.filter((line) => line.status === status).length

/** The line being rehearsed is the first one still waiting. */
export const state = (model: Model): Representation => {
  const runningIndex = model.phase === "rehearsing" ? model.results.findIndex((result) => result._tag === "Pending") : -1
  const lines = model.results.map((result, index) => lineOf(result, index, runningIndex))
  const failed = countOf(lines, "failed")
  return {
    controlState: controlStateOf(model, failed),
    understudy: model.understudy,
    round: model.round,
    lines,
    total: lines.length,
    passed: countOf(lines, "passed"),
    failed
  }
}

const callNextLine = (representation: Representation): Option.Option<Intent> => {
  const next = Option.fromNullishOr(representation.lines.find((line) => line.status === "running"))
  return Option.map(
    next,
    (line) =>
      ({
        _tag: "RunPath",
        round: representation.round,
        index: line.index,
        understudy: representation.understudy
      }) as const
  )
}

/** The prompter calls the next line of the call sheet while a rehearsal is on. */
const nap: Nap<Representation, Intent> = {
  idle: noIntent,
  rehearsing: callNextLine,
  clean: noIntent,
  flawed: noIntent
}

/** A beat before each path, so the line lights before the house moves. */
const LEAD_MILLIS = 240

const failedProposal = (round: number, index: number, failure: PathFailure): Proposal => ({
  _tag: "PathFailed",
  round,
  index,
  failure: {
    target: failure.target,
    stepIndex: failure.stepIndex,
    expected: failure.expected,
    actual: failure.actual,
    message: failure.message
  }
})

const runPath = (intent: WithTag<Intent, "RunPath">) => {
  const { round, index, understudy } = intent
  return Option.match(Option.fromNullishOr(callSheet[index]), {
    onNone: () => Effect.die(`the call sheet has no line ${index}`),
    onSome: (line) =>
      Effect.sleep(LEAD_MILLIS).pipe(
        Effect.flatMap(() => rehearsePath(understudy, line.path)),
        Effect.as<Proposal>({ _tag: "PathPassed", round, index }),
        Effect.catchTag("PathFailure", (failure) => Effect.succeed(failedProposal(round, index, failure)))
      )
  })
}

/**
 * The test runner as a loop of its own: `RunPath` runs one path of the honest graph on an
 * understudy, and `nap` calls the next line until none is waiting. The action needs the understudies'
 * `ModelPort` and `HistoryPort`, which the act's layer provides.
 */
export const Rehearsal = define({
  name: "Rehearsal",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  initial,
  acceptors: {
    Called: acceptCalled,
    Settled: acceptSettled,
    Dismissed: acceptDismissed,
    PathPassed: acceptPathPassed,
    PathFailed: acceptPathFailed
  },
  reactors: [],
  state,
  nap,
  actions: {
    Rehearse: ({ understudy }) => Effect.succeed({ _tag: "Called", understudy }),
    Settle: ({ understudy }) => Effect.succeed({ _tag: "Settled", understudy }),
    Dismiss: () => resetUnderstudies.pipe(Effect.as({ _tag: "Dismissed" } as const)),
    RunPath: runPath
  }
})

export const RehearsalPorts = makePorts(Rehearsal)
