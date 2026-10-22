import {
  type AnyDefinition,
  type DispatchRefused,
  exploreGraph,
  type Explore,
  type ExploreOptions,
  type Graph,
  type HistoryPort,
  type IntentOf,
  type IntentPort,
  type ModelPort,
  type ModelPortShape,
  type Path,
  type PathStep,
  type Ports,
  type RepresentationOf,
  shortestPaths,
  simplePaths,
  unreachableControlStates
} from "@mufw/core"
import { Effect, Option, Schema, Stream } from "effect"

export type StateAssertions<D extends AnyDefinition> = {
  readonly [S in RepresentationOf<D>["controlState"]]: (representation: RepresentationOf<D>) => void
}

export interface TestModelOptions<D extends AnyDefinition> extends ExploreOptions<D> {
  /** The same alphabet the app gives the Stately adapter. */
  readonly explore: Explore<D>
  /** One assertion per node; throw to fail. */
  readonly states: StateAssertions<D>
}

export class PathFailure extends Schema.TaggedError<PathFailure>()("PathFailure", {
  target: Schema.String,
  stepIndex: Schema.Int,
  expected: Schema.String,
  actual: Schema.String,
  message: Schema.String
}) {}

/** Performs one transition of a path on the real system. `E` is how the transition itself can fail. */
export interface Driver<D extends AnyDefinition, R, E = never> {
  readonly step: (step: PathStep<D>) => Effect.Effect<void, E, R>
  /** `true` when the transition is applied by the time `step` returns, so no waiting is needed. */
  readonly appliesOnReturn: boolean
}

export interface TestModel<D extends AnyDefinition> {
  readonly graph: Graph<D>
  readonly shortestPaths: () => ReadonlyArray<Path<D>>
  readonly simplePaths: () => ReadonlyArray<Path<D>>
  /** Test name of a path. */
  readonly describe: (path: Path<D>) => string
  /** Resets to the `init` record, then drives each step and asserts the node reached. */
  readonly run: <R = ModelPort<D>, E = never>(
    path: Path<D>,
    driver?: Driver<D, R, E>
  ) => Effect.Effect<void, PathFailure | E, ModelPort<D> | HistoryPort<D> | R>
}

const STEP_TIMEOUT = "5 seconds"

/** Default driver: presents the step's proposal, in-process or through the `Present` RPC. */
export const presentDriver = <D extends AnyDefinition>(ports: Ports<D>): Driver<D, ModelPort<D>> => ({
  appliesOnReturn: true,
  step: (step) => ports.ModelPort.use((model) => model.present(step.proposal))
})

/**
 * Dispatches an intent for each step, so the transition goes through the actions. A refused
 * dispatch fails the step with `DispatchRefused`; the per-request services of `ports` are
 * required of whoever runs the path.
 */
export const intentDriver = <D extends AnyDefinition, R = never>(
  ports: Ports<D, R>,
  intentFor: (step: PathStep<D>) => IntentOf<D>
): Driver<D, IntentPort<D> | R, DispatchRefused> => ({
  appliesOnReturn: false,
  step: (step) => ports.IntentPort.use((intents) => intents.dispatch(intentFor(step)))
})


const describePath = <D extends AnyDefinition>(path: Path<D>) => {
  if (path.steps.length === 0) return `reaches ${path.target} (initial)`
  const tags = path.steps.map((step) => step.proposal._tag)
  return `reaches ${path.target} via ${tags.join(" → ")}`
}

interface Checkpoint {
  readonly target: string
  readonly stepIndex: number
  readonly expected: string
}

const makeRunner = <D extends AnyDefinition>(ports: Ports<D>, graph: Graph<D>, options: TestModelOptions<D>) => {
  const key = options.key ?? ((representation: RepresentationOf<D>) => representation.controlState)
  const assertions: Record<string, ((representation: RepresentationOf<D>) => void) | undefined> = options.states

  const current = (model: ModelPortShape<D>) =>
    Stream.runHead(model.representations).pipe(Effect.map(Option.getOrThrow))

  const reached = (model: ModelPortShape<D>, expected: string) =>
    model.representations.pipe(
      Stream.filter((representation) => key(representation) === expected),
      Stream.runHead,
      Effect.timeoutOption(STEP_TIMEOUT),
      Effect.map(Option.flatten),
      Effect.flatMap(Option.match({ onNone: () => current(model), onSome: Effect.succeed }))
    )

  const check = (checkpoint: Checkpoint, representation: RepresentationOf<D>) => {
    const actual = key(representation)
    const fail = (message: string) => new PathFailure({ ...checkpoint, actual, message })
    if (actual !== checkpoint.expected) return Effect.fail(fail(`expected ${checkpoint.expected}, reached ${actual}`))
    const assertion = assertions[actual]
    if (assertion === undefined) return Effect.fail(fail(`no assertion for ${actual}`))
    return Effect.try({
      try: () => assertion(representation),
      catch: (error) => fail(error instanceof Error ? error.message : String(error))
    })
  }

  return <R, E>(path: Path<D>, driver: Driver<D, R, E>) =>
    Effect.gen(function*() {
      const model = yield* ports.ModelPort
      yield* ports.HistoryPort.use((history) => history.travelTo(0)).pipe(Effect.orDie)
      yield* check({ target: path.target, stepIndex: -1, expected: graph.initial }, yield* current(model))
      for (const [stepIndex, step] of path.steps.entries()) {
        yield* driver.step(step)
        const settled = driver.appliesOnReturn || step.from === step.to
        const representation = yield* (settled ? current(model) : reached(model, step.to))
        yield* check({ target: path.target, stepIndex, expected: step.to }, representation)
      }
    })
}

/**
 * Explores the definition's graph and returns its paths plus a runner that replays them against
 * whatever `ModelPort`/`HistoryPort` is provided. Throws when a declared control state is unreachable.
 */
export const createTestModel = <D extends AnyDefinition>(
  def: D,
  ports: Ports<D>,
  options: TestModelOptions<D>
): TestModel<D> => {
  const graph = exploreGraph(def, options.explore, options)
  const unreachable = unreachableControlStates(def, graph)
  if (unreachable.length > 0) throw new Error(`mufw: unreachable control states: ${unreachable.join(", ")}`)
  const runPath = makeRunner(ports, graph, options)
  return {
    graph,
    shortestPaths: () => shortestPaths(graph),
    simplePaths: () => simplePaths(graph),
    describe: describePath,
    run: (path, driver) => runPath(path, driver ?? (presentDriver(ports) as Driver<D, any, any>))
  }
}
