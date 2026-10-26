import type { Forward } from "@mufw/core"
import { Option } from "effect"
import type { Deck, Representation as DeckRepresentation } from "../../deck/Deck.ts"
import type { BoxOffice, Representation as BoxRepresentation } from "../../domain/BoxOffice.ts"
import type { Marquee, Sign } from "./Marquee.ts"
import type { FrontOfHouse, Playhouse } from "./playhouse.ts"
import { script } from "./script.ts"

type Front = typeof BoxOffice
type Painter = typeof Marquee

const FEW_LEFT = 4

const signOf = (representation: BoxRepresentation): Sign => {
  if (representation.controlState === "curtain") return "playing"
  if (representation.controlState === "full") return "sold"
  return representation.free <= FEW_LEFT ? "few" : "tonight"
}

const looksTheSame = (before: BoxRepresentation, current: BoxRepresentation): boolean =>
  signOf(before) === signOf(current) && before.free === current.free

/** A hold expiring moves the clock, not the sign: only a change of what the sign says or counts is worth a repaint. */
export const repaintOnChange: Forward<Front, Painter> = (previous, current) =>
  Option.exists(previous, (before) => looksTheSame(before, current))
    ? Option.none()
    : Option.some({ _tag: "Repaint", sign: signOf(current), free: current.free })

const isOnCue = (spot: string) => (representation: DeckRepresentation): boolean =>
  representation.actId === script.id && representation.cue === script.cues.findIndex((cue) => cue.spot === spot)

/** True for the deck's change into the cue that lights `spot`, and for no other change. */
const enteredCue = (spot: string) => (previous: Option.Option<DeckRepresentation>, current: DeckRepresentation): boolean =>
  isOnCue(spot)(current) && !Option.exists(previous, isOnCue(spot))

/** The stage manager dims the house on the cue about forwarding: the play's doors open in the same step. */
export const dimTheHouse: Forward<typeof Deck, typeof Playhouse> = (previous, current) =>
  enteredCue("controls")(previous, current) ? Option.some({ _tag: "DimLights" }) : Option.none()

/** The stage manager opens the doors of the box office out front on the cue about the two islands. */
export const openFrontDoors: Forward<typeof Deck, typeof FrontOfHouse> = (previous, current) =>
  enteredCue("islands")(previous, current) ? Option.some({ _tag: "OpenDoors" }) : Option.none()
