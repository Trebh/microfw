import { BrowserRuntime } from "@effect/platform-browser"
import { layerLoopLocal } from "@mufw/core"
import { layerInputScheduler, layerMount } from "@mufw/view-uhtml"
import { Effect, Layer } from "effect"
import { render } from "uhtml"
import { acts, scripts, type StageServices } from "./acts/registry.ts"
import { layerCurrentPatronFixed } from "./adapters/currentPatronFixed.ts"
import { layerPaymentTheatrical } from "./adapters/paymentTheatrical.ts"
import { Book, BookPorts } from "./deck/Book.ts"
import { layerCurtain } from "./deck/curtain.ts"
import { Deck, DeckPorts, initialModel, programOf } from "./deck/Deck.ts"
import { layerHash } from "./deck/hash.ts"
import { layerInterruption } from "./deck/interruption.ts"
import { layerKeys } from "./deck/keys.ts"
import { layerPrompterBook } from "./deck/prompterBook.ts"
import { buildSkeleton } from "./deck/skeleton.ts"
import { layerSpotlight } from "./deck/spotlight.ts"
import { makeDeckView } from "./deck/view.ts"
import { BoxOffice, BoxOfficePorts, Patron } from "./domain/BoxOffice.ts"

const theatre = document.getElementById("theatre")
if (theatre === null) throw new Error("index.html has no #theatre")

const skeleton = buildSkeleton(theatre, acts)

/** The stage every act shares: one box office, run in this page, paid at the theatrical gateway, as one patron. */
const stage = layerLoopLocal(BoxOffice, BoxOfficePorts).pipe(
  Layer.provideMerge(Layer.mergeAll(layerPaymentTheatrical, layerCurrentPatronFixed(Patron.make("you"))))
)

/** The deck starts at the act the location hash names, else at the overture. */
const deck = layerLoopLocal(Deck, DeckPorts, { initial: initialModel(programOf(scripts), location.hash) })

const book = layerLoopLocal(Book, BookPorts)

const loops = Layer.mergeAll(stage, deck, book)

const actIslands = skeleton.stages.reduce<Layer.Layer<never, never, StageServices>>(
  (islands, { act, root }) => Layer.merge(islands, act.layer(root)),
  Layer.empty
)

const page = Layer.mergeAll(
  layerMount(DeckPorts, {
    root: skeleton.chrome,
    view: makeDeckView(scripts),
    render,
    onRefused: (refused) => Effect.logWarning(refused)
  }),
  layerSpotlight(scripts, { stage: skeleton.stage, overlay: skeleton.spotlight }),
  layerCurtain({ frame: skeleton.frame, stage: skeleton.stage }),
  layerHash,
  layerInterruption,
  layerKeys(scripts.map((script) => script.id)),
  layerPrompterBook({ drawer: skeleton.bookDrawer, tab: skeleton.bookTab, panel: skeleton.bookPanel }),
  actIslands
).pipe(Layer.provide(loops), Layer.provide(layerInputScheduler))

BrowserRuntime.runMain(Layer.launch(page))
