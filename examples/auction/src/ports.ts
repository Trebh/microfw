import { makePorts } from "@mufw/core"
import { makeRpc } from "@mufw/rpc"
import { Authentication } from "./authentication.ts"
import { Auction } from "./auction/Auction.ts"
import { Wallet } from "./wallet/Wallet.ts"

export const Ports = makePorts(Auction)
export const WalletPorts = makePorts(Wallet)
export const Rpc = makeRpc(Auction, Ports, Authentication)
/** The wallet's wire contract: its actions need no identity, so no middleware. */
export const WalletRpc = makeRpc(Wallet, WalletPorts)
