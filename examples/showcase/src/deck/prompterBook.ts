import { layerPanel } from "@mufw/devtools"
import { layerMount, type View } from "@mufw/view-uhtml"
import { Effect, Layer, Stream } from "effect"
import { html } from "uhtml"
import { BookPorts, type Intent, type Representation } from "./Book.ts"
import { Deck, DeckPorts } from "./Deck.ts"

export interface PrompterBookRoots {
  /** The drawer: it carries `data-open="true" | "false"` and is `inert` while closed. */
  readonly drawer: HTMLElement
  /** The ticket that opens and closes the drawer. */
  readonly tab: HTMLElement
  /** Where the deck's time-travel panel renders its rows. */
  readonly panel: HTMLElement
}

const tabView: View<Representation, Intent> = (representation, dispatch) =>
  html`<button
    type="button"
    class="stage-button"
    aria-controls="prompter-book"
    aria-expanded=${String(representation.open)}
    onclick=${() => dispatch({ _tag: "ToggleBook" })}
  >The prompter's book <kbd>B</kbd></button>`

const layerDrawer = (drawer: HTMLElement) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const model = yield* BookPorts.ModelPort
      const paint = (representation: Representation) =>
        Effect.sync(() => {
          drawer.dataset.open = String(representation.open)
          drawer.inert = !representation.open
        })
      yield* Effect.forkScoped(Stream.runForEach(model.representations, paint))
    })
  )

/**
 * The prompter's book: a drawer holding the deck's own time-travel panel. Clicking a row travels
 * the deck's history, which rewinds the presentation itself. Whether the drawer is open is the
 * `Book` loop's state, so a rewind of the deck leaves it open.
 */
export const layerPrompterBook = (roots: PrompterBookRoots) =>
  Layer.mergeAll(
    layerMount(BookPorts, {
      root: roots.tab,
      view: tabView,
      onRefused: (refused) => Effect.logWarning(refused)
    }),
    layerDrawer(roots.drawer),
    layerPanel(Deck, DeckPorts, { root: roots.panel })
  )
