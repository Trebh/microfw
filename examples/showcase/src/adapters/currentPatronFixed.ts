import { Layer } from "effect"
import { CurrentPatron } from "../domain/CurrentPatron.ts"
import type { Patron } from "../domain/Values.ts"

/** One identity for the whole page: the visitor is the only patron this browser acts for. */
export const layerCurrentPatronFixed = (patron: Patron) => Layer.succeed(CurrentPatron, { patron })
