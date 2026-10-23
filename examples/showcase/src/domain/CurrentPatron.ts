import { Context } from "effect"
import type { Patron } from "./Values.ts"

/** Who is acting for the current intent. Port only: an intent never carries the identity it runs under. */
export class CurrentPatron extends Context.Service<CurrentPatron, {
  readonly patron: Patron
}>()("showcase/CurrentPatron") {}
