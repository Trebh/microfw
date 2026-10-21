import type { View } from "@mufw/view-uhtml"
import { Option } from "effect"
import { html } from "uhtml"
import type { Intent, Representation } from "./domain/Auction.ts"

const placeBid = (bidder: string, dispatch: (intent: Intent) => void) => (event: SubmitEvent) => {
  event.preventDefault()
  const amount = Number(new FormData(event.currentTarget as HTMLFormElement).get("amount"))
  dispatch({ _tag: "PlaceBid", bidder, amount })
}

export const makeView = (bidder: string, placement: string): View<Representation, Intent> =>
(representation, dispatch) => {
  const sold = representation.controlState === "sold"
  const highest = Option.match(representation.highest, {
    onNone: () => "no bids",
    onSome: (bid) => `${bid.bidder} ${bid.amount}`
  })
  const rejection = Option.getOrElse(representation.lastRejection, () => "")
  const bids = [...representation.bids].reverse()
  return html`
    <header>
      <h1>${representation.item}</h1>
      <span class=${`badge ${representation.controlState}`}>${representation.controlState}</span>
      <span class="remaining">remaining: ${representation.remainingSeconds}s</span>
    </header>
    <p class="highest">highest: ${highest}</p>
    <form onsubmit=${placeBid(bidder, dispatch)}>
      <input name="amount" type="number" .value=${representation.minimumBid}>
      <button ?disabled=${sold}>Place bid</button>
    </form>
    <p class="rejection">${rejection}</p>
    <ol class="bids">${bids.map((bid) => html`<li>${bid.bidder} ${bid.amount}</li>`)}</ol>
    <footer>${placement}</footer>
  `
}
