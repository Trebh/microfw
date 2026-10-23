import { Layer } from "effect"
import { layerCurrentPatronFixed } from "../../adapters/currentPatronFixed.ts"
import { layerPaymentTheatrical } from "../../adapters/paymentTheatrical.ts"
import { Patron } from "../../domain/BoxOffice.ts"

/**
 * What the box office's actions need from the world: a gateway and a patron. Every company brings
 * its own, wherever it runs, so the worker builds this layer in its own realm.
 */
export const backstage = Layer.mergeAll(layerPaymentTheatrical, layerCurrentPatronFixed(Patron.make("you")))
