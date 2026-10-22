import { layerLoopLocal } from "@mufw/core"
import { Wallet } from "../../domain/Wallet.ts"
import { WalletPorts } from "../../ports.ts"

/** The wallet's model and actions live in the browser on every page: nothing of it is served, so it needs no RPC. */
export const walletBrowserOnly = layerLoopLocal(Wallet, WalletPorts)
