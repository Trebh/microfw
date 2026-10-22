import { Option } from "effect"
import type { html as Html } from "uhtml"
import type { Representation } from "./domain/Auction.ts"

/**
 * The ticker only shows the auction's control state and highest bid, with no control: the view takes
 * no `dispatch`, so it cannot send an intent. `source` says where the representations come from.
 */
export const makeTickerViewWith = (html: typeof Html) => (source: string) => (representation: Representation) => {
  const highest = Option.match(representation.highest, {
    onNone: () => "no bids",
    onSome: (bid) => `${bid.bidder} ${bid.amount}`
  })
  return html`
    <section class="ticker">
      <h2>Ticker</h2>
      <span class=${`badge ${representation.controlState}`}>${representation.controlState}</span>
      <p class="highest">highest: ${highest}</p>
      <footer>${source}</footer>
    </section>
  `
}
