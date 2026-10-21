import { makePorts } from "@mufw/core"
import { makeRpc } from "@mufw/rpc"
import { Auction } from "./domain/Auction.ts"

export const Ports = makePorts(Auction)
export const Rpc = makeRpc(Auction, Ports)
