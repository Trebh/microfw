import { it } from "@effect/vitest"
import { Option } from "effect"
import { expectTypeOf } from "vitest"
import { applyProposal, compose, type IntentOf, type ModelOf, type ProposalOf, type RepresentationOf } from "../src/index.ts"
import { Counter } from "./fixtures/Counter.ts"
import { CounterRows } from "./fixtures/CounterRows.ts"
import { Duo } from "./fixtures/Duo.ts"
import { Roster } from "./fixtures/Roster.ts"

it("types the model of a composed definition from its parent and parts", () => {
  expectTypeOf<ModelOf<typeof Duo>>().toEqualTypeOf<{
    readonly parent: { readonly total: number }
    readonly parts: { readonly Left: { readonly count: number }; readonly Right: { readonly count: number } }
  }>()
})

it("types a collection's model as its keyed instances", () => {
  expectTypeOf<ModelOf<typeof CounterRows>["parts"]["Rows"]>().toEqualTypeOf<
    ReadonlyArray<{ readonly key: string; readonly model: { readonly count: number } }>
  >()
})

it("types a collection's proposal and intent with the instance key", () => {
  expectTypeOf<Extract<ProposalOf<typeof CounterRows>, { readonly _tag: "Rows" }>["key"]>().toEqualTypeOf<string>()
  expectTypeOf<Extract<IntentOf<typeof CounterRows>, { readonly _tag: "Rows" }>["key"]>().toEqualTypeOf<string>()
})

it("types a slot's proposal without a key", () => {
  expectTypeOf<Extract<ProposalOf<typeof Duo>, { readonly _tag: "Left" }>>().not.toHaveProperty("key")
})

it("types the combined control state of the representation", () => {
  expectTypeOf<RepresentationOf<typeof Duo>["controlState"]>().toEqualTypeOf<
    "low/low" | "low/high" | "high/low" | "high/high"
  >()
})

it("types the control state as the parent's by default", () => {
  const Plain = compose(Roster, (part) => ({ Rows: part.collection(Counter, { keys: (roster) => roster.ids }) }))

  expectTypeOf<RepresentationOf<typeof Plain>["controlState"]>().toEqualTypeOf<"empty" | "listed">()
})

it("types the control state as the option's values when the option combines them", () => {
  expectTypeOf<RepresentationOf<typeof CounterRows>["controlState"]>().toEqualTypeOf<"empty" | "listed" | "busy">()
})

it("rejects a keys function that reads a field the parent's model lacks", () => {
  // @ts-expect-error `Roster`'s model has `ids`, not `rows`
  void (() => compose(Roster, (part) => ({ Rows: part.collection(Counter, { keys: (roster) => roster.rows }) })))
})

it("rejects a keys function that does not return keys", () => {
  // @ts-expect-error `keys` returns an array of strings
  void (() => compose(Roster, (part) => ({ Rows: part.collection(Counter, { keys: (roster) => roster.ids.length }) })))
})

it("rejects a create function that returns a model the child does not have", () => {
  // @ts-expect-error the child's model is `{ count }`
  void (() => compose(Roster, (part) => ({ Rows: part.collection(Counter, { keys: (roster) => roster.ids, create: () => ({ total: 1 }) }) })))
})

it("rejects a toParent that returns a proposal the parent does not have", () => {
  // @ts-expect-error `Nope` is not a proposal of `Roster`
  void (() => compose(Roster, (part) => ({ Rows: part.collection(Counter, { keys: (r) => r.ids, toParent: () => Option.some({ _tag: "Nope" } as const) }) })))
})

it("rejects a fromParent that returns a proposal the child does not have", () => {
  // @ts-expect-error `Nope` is not a proposal of `Counter`
  void (() => compose(Roster, (part) => ({ Left: part.slot(Counter, { fromParent: () => Option.some({ _tag: "Nope" } as const) }) })))
})

it("rejects a collection proposal without a key", () => {
  // @ts-expect-error an instance's proposal names its key
  void (() => applyProposal(CounterRows, CounterRows.initial, { _tag: "Rows", proposal: { _tag: "Reset" } }))
})

it("rejects a slot hook that takes a key", () => {
  // @ts-expect-error a slot has one instance, so its hooks receive only the proposal
  void (() => compose(Roster, (part) => ({ Left: part.slot(Counter, { toParent: (proposal, key: string) => Option.none() }) })))
})
