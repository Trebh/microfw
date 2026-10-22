import { makePorts } from "@mufw/core"
import { makeRpc } from "@mufw/rpc"
import { Authentication } from "./authentication.ts"
import { Auction } from "./domain/Auction.ts"
import { Wallet } from "./domain/Wallet.ts"

export const Ports = makePorts(Auction)
export const WalletPorts = makePorts(Wallet)
export const Rpc = makeRpc(Auction, Ports, Authentication)
