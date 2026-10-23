import { AutoActions, layerLoopLocal, makePorts, type ModelPort, type Path, type Ports } from "@mufw/core"
import { createTestModel, type Driver, presentDriver, type TestModelOptions } from "@mufw/test"
import { Effect, Layer, Schema } from "effect"
import { layerCurrentPatronFixed } from "../../adapters/currentPatronFixed.ts"
import { layerPaymentTheatrical } from "../../adapters/paymentTheatrical.ts"
import {
  type BoxOffice,
  company,
  exploreBoxOffice,
  type Model,
  Patron,
  type Representation,
  serializeBoxOffice,
  state
} from "../../domain/BoxOffice.ts"

/** Which of the two understudies a rehearsal is run on. */
export const UnderstudyName = Schema.Literals(["honest", "sabotaged"])
export type UnderstudyName = typeof UnderstudyName.Type

type ControlState = Representation["controlState"]
type OfficePath = Path<typeof BoxOffice>

/** What a control state asserts: the text the call sheet shows is the text the check enforces. */
export interface Expectation {
  readonly expects: string
  readonly holds: (representation: Representation) => boolean
}

export const expectations: Record<ControlState, Expectation> = {
  dark: {
    expects: "no seat held or sold, all 18 free",
    holds: (representation) => representation.sold + representation.held === 0 && representation.free === 18
  },
  selling: {
    expects: "at least one seat free",
    holds: (representation) => representation.free > 0
  },
  full: {
    expects: "no seat free",
    holds: (representation) =>
      representation.free === 0 && representation.seats.every((seat) => seat.status !== "free")
  },
  curtain: {
    expects: "no seat still held",
    holds: (representation) => representation.held === 0
  }
}

/** `createTestModel` takes an assertion that throws to fail. */
const assertion = ({ expects, holds }: Expectation) => (representation: Representation): void => {
  if (!holds(representation)) throw new Error(`expected ${expects}, the house shows ${representation.free} free`)
}

const options: TestModelOptions<typeof BoxOffice> = {
  explore: exploreBoxOffice,
  serialize: serializeBoxOffice,
  states: {
    dark: assertion(expectations.dark),
    selling: assertion(expectations.selling),
    full: assertion(expectations.full),
    curtain: assertion(expectations.curtain)
  }
}

export const honestUnderstudy = company("Understudy")

/** The control state the broken rule misreports. */
export const SABOTAGED_TARGET: ControlState = "full"

/** The broken rule: a house with no seat free is still reported as `selling`. */
const reportsFullHouseAsSelling = (model: Model): Representation => {
  const reading = state(model)
  return reading.controlState === SABOTAGED_TARGET ? { ...reading, controlState: "selling" } : reading
}

/** The same schemas, acceptors, reactors and actions as the honest understudy; only `state` is wrong. */
export const sabotagedUnderstudy: typeof BoxOffice = {
  ...company("Understudy (sabotaged)"),
  state: reportsFullHouseAsSelling
}

export const honestPorts = makePorts(honestUnderstudy)
export const sabotagedPorts = makePorts(sabotagedUnderstudy)

/** The rehearsal presents proposals itself, so no action runs; the loop still captures the services its actions name. */
const quietLoop = (definition: typeof BoxOffice, ports: Ports<typeof BoxOffice>) =>
  layerLoopLocal(definition, ports).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerPaymentTheatrical,
        layerCurrentPatronFixed(Patron.make("understudy")),
        Layer.succeed(AutoActions, false)
      )
    )
  )

/** Both understudies live for the life of the page; the rehearsal picks one per path. */
export const layerUnderstudies = Layer.merge(
  quietLoop(honestUnderstudy, honestPorts),
  quietLoop(sabotagedUnderstudy, sabotagedPorts)
)

/** The expectations are written against the honest definition, whichever understudy the paths run on. */
const rehearsalOn = (ports: Ports<typeof BoxOffice>) => createTestModel(honestUnderstudy, ports, options)

export const honestRehearsal = rehearsalOn(honestPorts)

/** How long each step waits, so the audience can watch the house fill. */
const STEP_MILLIS = 160

const slowDriver = (ports: Ports<typeof BoxOffice>): Driver<typeof BoxOffice, ModelPort<typeof BoxOffice>> => {
  const present = presentDriver(ports)
  return {
    appliesOnReturn: present.appliesOnReturn,
    step: (step) => Effect.sleep(STEP_MILLIS).pipe(Effect.flatMap(() => present.step(step)))
  }
}

const sabotagedRehearsal = rehearsalOn(sabotagedPorts)

const benches = {
  honest: { rehearsal: honestRehearsal, ports: honestPorts },
  sabotaged: { rehearsal: sabotagedRehearsal, ports: sabotagedPorts }
} as const

/** Runs one path of the honest graph against the named understudy. */
export const rehearsePath = (understudy: UnderstudyName, path: OfficePath) => {
  const { rehearsal, ports } = benches[understudy]
  return rehearsal.run(path, slowDriver(ports))
}

/** Seq 0 is never evicted, so travelling to it cannot fail. */
const backToDark = (ports: Ports<typeof BoxOffice>) =>
  ports.HistoryPort.use((history) => history.travelTo(0)).pipe(Effect.orDie)

/** Both houses go dark again. */
export const resetUnderstudies = Effect.forEach([honestPorts, sabotagedPorts], backToDark, { discard: true })
