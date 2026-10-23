import { makePorts, nest } from "@mufw/core"
import { Option } from "effect"
import { company, type Representation as BoxRepresentation } from "../../domain/BoxOffice.ts"
import { House, LIGHTS } from "./house.ts"
import { Marquee } from "./marquee.ts"

/** The box office staged inside the house: the play within the play. */
export const Mousetrap = company("Mousetrap")

/** The box office out front, on its own loop. */
export const FrontOfHouse = company("FrontOfHouse")

const PLAY_STATES = ["dark", "selling", "full", "curtain"] as const satisfies ReadonlyArray<
  BoxRepresentation["controlState"]
>

/** Every control state of the nested definition: the house lights and the play, side by side. */
const HOUSE_AND_PLAY = LIGHTS.flatMap((lights) => PLAY_STATES.map((play) => `${lights}/${play}` as const))

/**
 * One definition for both: the curtain rising dims the house in the same step, and dimming the
 * house opens the play's doors in the same step.
 */
export const Playhouse = nest(House, Mousetrap, {
  toParent: (proposal) =>
    proposal._tag === "CurtainUp" ? Option.some({ _tag: "LightsDimmed", at: proposal.at }) : Option.none(),
  toChild: (proposal) =>
    proposal._tag === "LightsDimmed" ? Option.some({ _tag: "DoorsOpened", at: proposal.at }) : Option.none(),
  controlState: (house, play) => `${house.controlState}/${play.controlState}` as const,
  controlStates: HOUSE_AND_PLAY
})

export const PlayhousePorts = makePorts(Playhouse)
export const FrontPorts = makePorts(FrontOfHouse)
export const MarqueePorts = makePorts(Marquee)
