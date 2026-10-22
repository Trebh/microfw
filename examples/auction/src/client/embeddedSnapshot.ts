import { Effect, Option } from "effect"
import { AUCTION_SNAPSHOT_ID } from "../snapshot.ts"

/**
 * The text of the auction model that a server-rendered page embeds, or `None` when the page has
 * none (the vite dev server renders nothing). An element with no text is `Some("")`: it is present
 * and malformed, which the caller's decoding reports.
 */
export const embeddedAuctionSnapshot: Effect.Effect<Option.Option<string>> = Effect.sync(() =>
  Option.fromNullishOr(document.getElementById(AUCTION_SNAPSHOT_ID)).pipe(
    Option.map((element) => element.textContent ?? "")
  )
)
