import type { View } from "@mufw/view-uhtml"
import type { html as Html } from "uhtml"
import type { Intent, Representation } from "./domain/Wallet.ts"

/** The wallet only shows: it offers no control, so the view never dispatches. `owner` labels whose wallet it is. */
export const makeWalletViewWith = (html: typeof Html) => (owner: string): View<Representation, Intent> => (representation) =>
  html`
    <section class="wallet">
      <h2>Wallet</h2>
      <span class=${`badge ${representation.controlState}`}>${representation.controlState}</span>
      <p class="credit">credit: ${representation.credit}</p>
      <p class="reserved">reserved: ${representation.reserved}</p>
      <p class="available">available: ${representation.available}</p>
      <footer>${owner}</footer>
    </section>
  `
