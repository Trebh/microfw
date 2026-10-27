import type { HistoryPort, IntentPort, ModelPort } from "@mufw/core"
import type { Act, ActScript } from "../act.ts"
import type { Deck } from "../deck/Deck.ts"
import type { BoxOffice } from "../domain/BoxOffice.ts"
import type { CurrentPatron } from "../domain/CurrentPatron.ts"
import type { PaymentGateway } from "../domain/PaymentGateway.ts"
import { finaleAct } from "./finale/index.ts"
import { loopAct } from "./loop/index.ts"
import { mapAct } from "./map/index.ts"
import { overtureAct } from "./overture/index.ts"
import { rehearsalAct } from "./rehearsal/index.ts"
import { repertoryAct } from "./repertory/index.ts"
import { rewindAct } from "./rewind/index.ts"
import { syncAct } from "./sync/index.ts"
import { tourAct } from "./tour/index.ts"
import { withinAct } from "./within/index.ts"

/** Everything the composition root provides to an act's layer. */
export type StageServices =
  | IntentPort<typeof BoxOffice>
  | ModelPort<typeof BoxOffice>
  | HistoryPort<typeof BoxOffice>
  | IntentPort<typeof Deck>
  | ModelPort<typeof Deck>
  | HistoryPort<typeof Deck>
  | PaymentGateway
  | CurrentPatron

/** The acts in running order. An act that needs fewer services than `StageServices` fits as it is. */
export const acts: ReadonlyArray<Act<StageServices>> = [
  overtureAct,
  loopAct,
  rewindAct,
  mapAct,
  rehearsalAct,
  tourAct,
  withinAct,
  repertoryAct,
  syncAct,
  finaleAct
]

/** What the playbill, the surtitles and the deck's program are made from. */
export const scripts: ReadonlyArray<ActScript> = acts.map((act) => act.script)
