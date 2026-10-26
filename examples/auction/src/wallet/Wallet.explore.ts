import type { Explore } from "@mufw/core"
import { Amount } from "../domain/Values.ts"
import type { Representation, Wallet } from "./Wallet.ts"

/** From any state: a part of the credit, all of it, more than it, and a release. */
export const exploreWallet: Explore<typeof Wallet> = (_representation, model) => [
  { _tag: "Reserved", amount: Amount.make(40) },
  { _tag: "Reserved", amount: Amount.make(model.credit) },
  { _tag: "Refused", amount: Amount.make(model.credit + 1) },
  { _tag: "Released" }
]

/** What is held is a finer identity than the control state: a part held and nothing held are both `funded`. */
export const serializeWallet = (representation: Representation) =>
  `${representation.controlState}:${representation.reserved}`
