import { compose, makePorts } from "@mufw/core"
import { Option } from "effect"
import { company } from "../../domain/BoxOffice.ts"
import { Season } from "./Season.ts"

/** The season owns the bill: a night is a box office while the programme lists it, and not a step longer. */
export const Repertory = compose(Season, (part) => ({
  Nights: part.collection(company("Night"), {
    keys: (season) => season.programme,
    toParent: (proposal, key) =>
      proposal._tag === "CurtainRaised" ? Option.some({ _tag: "NightPlayed", night: key } as const) : Option.none(),
    fromParent: (proposal) =>
      proposal._tag === "SeasonOpened" ? Option.some({ _tag: "DoorsOpened", at: proposal.at } as const) : Option.none()
  })
}))

export const RepertoryPorts = makePorts(Repertory)
