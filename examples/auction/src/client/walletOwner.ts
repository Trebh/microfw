import { type IntentPort, layerForward, type ModelPort } from "@mufw/core"
import { Effect, Layer, Option } from "effect"
import type { Auction } from "../domain/Auction.ts"
import type { Bidder } from "../domain/Values.ts"
import { holdForBids } from "../domain/WalletFeed.ts"
import type { Wallet } from "../domain/Wallet.ts"
import { Whoami } from "../domain/Whoami.ts"
import { Ports, WalletPorts } from "../ports.ts"

/** Whose leading bids the wallet island reserves for; `None` is a wallet that follows nobody. */
export type WalletOwner = Option.Option<Bidder>

/**
 * The page's bidder, as `Whoami` says. A session the server refuses has no bidder: the wallet then
 * follows nobody.
 */
export const walletOwner: Effect.Effect<WalletOwner, never, Whoami> = Whoami.use((whoami) => whoami.bidder).pipe(
  Effect.map(Option.some),
  Effect.catchTag("Unauthenticated", () => Effect.succeed(Option.none<Bidder>()))
)

/**
 * Feeds the wallet from the auction for `owner`: the owner is the page's claim to the leading bid,
 * and nothing the server trusts depends on it. Without one the wallet is never fed.
 */
export const layerWalletFeed = (
  owner: WalletOwner
): Layer.Layer<never, never, ModelPort<typeof Auction> | IntentPort<typeof Wallet>> =>
  Option.match(owner, {
    onNone: () => Layer.empty,
    onSome: (bidder) => layerForward(Ports, WalletPorts, holdForBids(bidder))
  })
