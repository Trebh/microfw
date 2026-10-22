import { layerActionRunnerLocal, layerLoopLocal, layerModelLocal } from "@mufw/core"
import { Effect, Layer, Option } from "effect"
import { layerCreditCheckPermissive } from "../../adapters/creditCheckPermissive.ts"
import { layerCurrentBidderFixed } from "../../adapters/currentBidderFixed.ts"
import { Auction } from "../../domain/Auction.ts"
import type { Bidder } from "../../domain/Values.ts"
import { Ports } from "../../ports.ts"
import { ServerPorts } from "../../serverPorts.ts"
import { decodeSnapshot } from "../../snapshot.ts"
import { embeddedAuctionSnapshot } from "../embeddedSnapshot.ts"

/**
 * The only place a page builds the auction's local halves. Every page but `devtools` also runs the
 * wallet's local loop, so `layerModelLocal` and `layerActionRunnerLocal` are in every such bundle;
 * these three names are what `scripts/check-bundle.ts` looks for to tell whether a deployment ships
 * the auction's own.
 *
 * The auction's model starts from the snapshot a server-rendered page embeds, decoded here at the
 * composition root: a page with no snapshot starts from `Auction.initial`, one with a malformed
 * snapshot fails the layer with a `SchemaError`.
 */
export const auctionModelLocal = (snapshot: Effect.Effect<Option.Option<string>> = embeddedAuctionSnapshot) =>
  Layer.unwrap(
    snapshot.pipe(
      Effect.flatMap(Option.match({
        onNone: () => Effect.succeed(layerModelLocal(Auction, Ports)),
        onSome: (text) =>
          decodeSnapshot(text).pipe(Effect.map((initial) => layerModelLocal(Auction, Ports, { initial })))
      }))
    )
  )

/** The auction's actions in the browser, acting as `bidder` with no credit limit. */
export const auctionActionRunnerLocal = (bidder: Bidder) =>
  layerActionRunnerLocal(Auction, Ports).pipe(
    Layer.provide(Layer.merge(layerCreditCheckPermissive, layerCurrentBidderFixed(bidder)))
  )

/**
 * The auction's whole loop in a worker that serves it over RPC, with no credit limit. The bidder is
 * per request (`ServerPorts`): the worker's `Authentication` provides it, as a server's does.
 */
export const auctionLoopLocal = () => layerLoopLocal(Auction, ServerPorts).pipe(Layer.provide(layerCreditCheckPermissive))
