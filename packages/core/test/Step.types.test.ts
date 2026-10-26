import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { expectTypeOf } from "vitest"
import { define, noIntent, type StepRecord, stepRecordSchema, unchanged } from "../src/index.ts"
import { Counter } from "./fixtures/Counter.ts"

const counterRecordSchema = stepRecordSchema(Counter)

it("types the step record schema as the record of the concrete definition", () => {
  expectTypeOf<Schema.Schema.Type<typeof counterRecordSchema>>().toEqualTypeOf<StepRecord<typeof Counter>>()
})

it("resolves the step record's model from the concrete definition", () => {
  expectTypeOf<StepRecord<typeof Counter>["model"]>().toEqualTypeOf<{ readonly count: number }>()
})

it("keeps the step record schema free of services", () => {
  expectTypeOf<typeof counterRecordSchema["DecodingServices"]>().toEqualTypeOf<never>()
  expectTypeOf<typeof counterRecordSchema["EncodingServices"]>().toEqualTypeOf<never>()
})

const Mini = define({
  name: "mini",
  model: Schema.Struct({ count: Schema.Int }),
  proposal: Schema.Union([Schema.TaggedStruct("Added", {}), Schema.TaggedStruct("Cleared", {})]),
  intent: Schema.TaggedStruct("Add", {}),
  representation: Schema.Struct({ controlState: Schema.Literals(["empty", "filled"]) })
})

const actions = { Add: () => Effect.succeed({ _tag: "Added" } as const) }
const state = (model: { readonly count: number }) => ({
  controlState: model.count === 0 ? "empty" : "filled"
} as const)
const nap = { empty: noIntent, filled: noIntent }
const acceptors = { Added: unchanged, Cleared: unchanged }

it("compiles a behaviour with one acceptor per proposal tag and one nap entry per control state", () => {
  const behaviour = { initial: { count: 0 }, reactors: [], state, actions, acceptors, nap }

  expectTypeOf(Mini(behaviour).controlStates).toEqualTypeOf<ReadonlyArray<string>>()
})

it("rejects a behaviour that lacks the acceptor of a proposal tag", () => {
  // @ts-expect-error `Cleared` has no acceptor
  Mini({ initial: { count: 0 }, reactors: [], state, actions, nap, acceptors: { Added: unchanged } })
})

it("rejects a behaviour with an acceptor for a tag the proposal does not have", () => {
  // @ts-expect-error `Removed` is not a proposal tag
  Mini({ initial: { count: 0 }, reactors: [], state, actions, nap, acceptors: { ...acceptors, Removed: unchanged } })
})

it("rejects a behaviour that lacks the nap entry of a control state", () => {
  // @ts-expect-error `filled` has no nap entry
  Mini({ initial: { count: 0 }, reactors: [], state, actions, acceptors, nap: { empty: noIntent } })
})
