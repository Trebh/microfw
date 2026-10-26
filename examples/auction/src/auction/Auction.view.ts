import type { View } from "@mufw/view-uhtml"
import { Option } from "effect"
import type { html as Html } from "uhtml"
import { parseAmount } from "./amountInput.ts"
import { canBid, type Intent, type Representation } from "./Auction.ts"

const amountEntry = (form: HTMLFormElement): string | null => {
  const inputs = Array.from(form.getElementsByTagName("input"))
  const amount = inputs.find((input) => input.getAttribute("name") === "amount")
  return amount === undefined ? null : amount.value
}

const placeBid = (dispatch: (intent: Intent) => void) => (event: SubmitEvent) => {
  event.preventDefault()
  const entry = amountEntry(event.currentTarget as HTMLFormElement)
  Option.match(parseAmount(entry), {
    onNone: () => {},
    onSome: (amount) => dispatch({ _tag: "PlaceBid", amount })
  })
}

/**
 * The view takes the `html` tag as a parameter: uhtml's entry module needs a DOM at import time, so
 * only `Auction.view.dom.ts` imports it and a test can bring its own document. While the auction is opening the
 * bid form is disabled and the user can dispatch `Open` themselves: the automatic `Open` from `nap`
 * is not re-run after a travel and is dropped when automatic actions are off. The bid handler reads
 * the input through `getElementsByTagName` because `FormData(form)` does not exist outside a browser.
 * The form has `method="dialog"` so that a submit before the bundle mounts `onsubmit` on the
 * server-rendered markup does nothing: a dialog-method form outside a `<dialog>` does not navigate
 * (HTML form submission algorithm), where the default GET would replace the document's query, and
 * with it the session.
 */
export const makeAuctionViewWith = (html: typeof Html) => (placement: string): View<Representation, Intent> =>
(representation, dispatch) => {
  const bidding = canBid(representation)
  const opening = representation.controlState === "opening"
  const highest = Option.match(representation.highest, {
    onNone: () => "no bids",
    onSome: (bid) => `${bid.bidder} ${bid.amount}`
  })
  const rejection = Option.getOrElse(representation.lastRejection, () => "")
  const bids = [...representation.bids].reverse()
  const openControl = opening
    ? html`<p class="opening">
        The auction is opening.
        <button type="button" class="open" onclick=${() => dispatch({ _tag: "Open" })}>Open auction</button>
      </p>`
    : null
  return html`
    <header>
      <h1>${representation.item}</h1>
      <span class=${`badge ${representation.controlState}`}>${representation.controlState}</span>
      <span class="remaining">remaining: ${representation.remainingSeconds}s</span>
    </header>
    <p class="highest">highest: ${highest}</p>
    ${openControl}
    <form method="dialog" onsubmit=${placeBid(dispatch)}>
      <input name="amount" type="number" .value=${representation.minimumBid} ?disabled=${!bidding}>
      <button class="bid" ?disabled=${!bidding}>Place bid</button>
    </form>
    <p class="rejection">${rejection}</p>
    <ol class="bids">${bids.map((bid) => html`<li>${bid.bidder} ${bid.amount}</li>`)}</ol>
    <footer>${placement}</footer>
  `
}
