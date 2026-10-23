import { makePorts } from "@mufw/core"
import { makeRpc, type RpcTag } from "@mufw/rpc"
import { company } from "../../domain/BoxOffice.ts"

/** One company on tour: its own definition under its own name, and the keys of its ports. */
const stage = (id: "house" | "wings" | "town", name: string) => {
  const def = company(name)
  return { id, def, ports: makePorts(def) }
}

export const house = stage("house", "House")
export const wings = stage("wings", "Wings")
export const town = stage("town", "Town")

export type Stage = typeof house

/** The wire contract of the company in the wings: the page and its worker both build it from this. */
export const wingsRpc = makeRpc(wings.def, wings.ports)

/** What the worker serves: the page only submits intents and reads the model, so nothing else is routed. */
export const WINGS_RPCS: ReadonlyArray<RpcTag> = ["Submit", "Representations", "History"]

export const townRpc = makeRpc(town.def, town.ports)
