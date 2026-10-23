import { define } from "@mufw/core"
import { Clock, Effect, Option, Schema } from "effect"

export const LIGHTS = ["up", "dimmed", "dark"] as const
export const Lights = Schema.Literals(LIGHTS)
export type Lights = typeof Lights.Type

export const Model = Schema.Struct({ lights: Lights })
export type Model = typeof Model.Type

export const Proposal = Schema.Union([
  Schema.TaggedStruct("LightsDimmed", { at: Schema.Number }),
  Schema.TaggedStruct("LightsRaised", { at: Schema.Number })
])
export type Proposal = typeof Proposal.Type

export const Intent = Schema.Union([
  Schema.TaggedStruct("DimLights", {}),
  Schema.TaggedStruct("RaiseLights", {})
])
export type Intent = typeof Intent.Type

export const Representation = Schema.Struct({
  controlState: Lights,
  /** 1 with the lights up, 0 in the dark: the page reads it as a CSS custom property. */
  brightness: Schema.Number
})
export type Representation = typeof Representation.Type

const BRIGHTNESS: Record<Lights, number> = { up: 1, dimmed: 0.42, dark: 0 }

const darker: Record<Lights, Lights> = { up: "dimmed", dimmed: "dark", dark: "dark" }

export const acceptLightsDimmed = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "LightsDimmed" ? { lights: darker[model.lights] } : model

export const acceptLightsRaised = (model: Model, proposal: Proposal): Model =>
  proposal._tag === "LightsRaised" ? { lights: "up" } : model

export const state = (model: Model): Representation => ({
  controlState: model.lights,
  brightness: BRIGHTNESS[model.lights]
})

/** The house lights: the parent of the play within the play. Pure, with no automatic intent. */
export const House = define({
  name: "House",
  model: Model,
  proposal: Proposal,
  intent: Intent,
  representation: Representation
})({
  controlStates: LIGHTS,
  initial: { lights: "up" },
  acceptors: [acceptLightsDimmed, acceptLightsRaised],
  reactors: [],
  state,
  nap: () => Option.none(),
  actions: {
    DimLights: () => Clock.currentTimeMillis.pipe(Effect.map((at) => ({ _tag: "LightsDimmed", at }) as const)),
    RaiseLights: () => Clock.currentTimeMillis.pipe(Effect.map((at) => ({ _tag: "LightsRaised", at }) as const))
  }
})
