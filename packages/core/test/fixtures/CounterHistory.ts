import { Option } from "effect"
import type { ProposalOf, StepRecord } from "../../src/index.ts"
import { Counter } from "./Counter.ts"

type CounterRecord = StepRecord<typeof Counter>

/** Records of a counter history, as `layerModelLocal` writes them: `at` is `seq` seconds, the representation is derived from the count. */
export const initRecord = (count: number): CounterRecord => ({
  seq: 0,
  at: 0,
  kind: "init",
  proposal: Option.none(),
  model: { count },
  representation: Counter.state({ count })
})

export const stepRecord = (seq: number, proposal: ProposalOf<typeof Counter>, count: number): CounterRecord => ({
  seq,
  at: seq * 1000,
  kind: "step",
  proposal: Option.some(proposal),
  model: { count },
  representation: Counter.state({ count })
})

export const travelRecord = (seq: number, travelledTo: number, count: number): CounterRecord => ({
  seq,
  at: seq * 1000,
  kind: "travel",
  proposal: Option.none(),
  model: { count },
  representation: Counter.state({ count }),
  travelledTo
})
