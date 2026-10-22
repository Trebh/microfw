import { it } from "@effect/vitest"
import type { Schema } from "effect"
import { expectTypeOf } from "vitest"
import { type StepRecord, stepRecordSchema } from "../src/index.ts"
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
