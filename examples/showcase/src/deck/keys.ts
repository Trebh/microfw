import { Effect, FiberSet, Layer, Option } from "effect"
import { BookPorts, type Intent as BookIntent } from "./Book.ts"
import { DeckPorts, type Intent as DeckIntent } from "./Deck.ts"

/** What a key asks for: an intent of the deck, or of the prompter's book. */
export type Command =
  | { readonly _tag: "Deck"; readonly intent: DeckIntent }
  | { readonly _tag: "Book"; readonly intent: BookIntent }

const deck = (intent: DeckIntent): Command => ({ _tag: "Deck", intent })
const book = (intent: BookIntent): Command => ({ _tag: "Book", intent })

const next = deck({ _tag: "Next" })
const previous = deck({ _tag: "Previous" })

const fixedKeys: Readonly<Record<string, Command>> = {
  ArrowRight: next,
  " ": next,
  PageDown: next,
  ArrowLeft: previous,
  PageUp: previous,
  a: deck({ _tag: "ToggleAutoplay" }),
  b: book({ _tag: "ToggleBook" }),
  Escape: book({ _tag: "CloseBook" })
}

const jumpTo = (actId: string | undefined): Option.Option<Command> =>
  actId === undefined ? Option.none() : Option.some(deck({ _tag: "GoTo", actId, cue: 0 }))

/**
 * The command for a key: arrows, Space and page keys move through the cues, Home goes to the first
 * act, 1–9 to the act of that number (in `actIds` order), A toggles autoplay, B the prompter's book
 * and Esc closes it.
 */
export const commandFor = (key: string, actIds: ReadonlyArray<string>): Option.Option<Command> => {
  const normalised = key.length === 1 ? key.toLowerCase() : key
  if (normalised === "Home") return jumpTo(actIds[0])
  if (/^[1-9]$/.test(normalised)) return jumpTo(actIds[Number(normalised) - 1])
  return Object.hasOwn(fixedKeys, normalised) ? Option.fromNullishOr(fixedKeys[normalised]) : Option.none()
}

const TYPING = "input, textarea, select, [contenteditable='true']"
const ACTIVATES_ON_SPACE = "button, a[href], summary"

/** Keys typed into a field are the field's; Space on a focused button is the button's click, not a cue. */
export const isForTheTarget = (key: string, target: Element | null): boolean => {
  if (target === null) return false
  if (target.closest(TYPING) !== null) return true
  return key === " " && target.closest(ACTIVATES_ON_SPACE) !== null
}

const hasModifier = (event: KeyboardEvent) => event.ctrlKey || event.metaKey || event.altKey

/** Drives the show from the keyboard, through the deck's and the book's intent ports. */
export const layerKeys = (actIds: ReadonlyArray<string>) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const deckIntents = yield* DeckPorts.IntentPort
      const bookIntents = yield* BookPorts.IntentPort
      const runFork = yield* FiberSet.makeRuntime()

      const run = (command: Command) =>
        (command._tag === "Deck" ? deckIntents.dispatch(command.intent) : bookIntents.dispatch(command.intent)).pipe(
          Effect.catchTag("DispatchRefused", (refused) => Effect.logWarning(refused))
        )

      const onKeyDown = (event: KeyboardEvent) => {
        const target = event.target instanceof Element ? event.target : null
        if (hasModifier(event) || isForTheTarget(event.key, target)) return
        const command = commandFor(event.key, actIds)
        if (Option.isNone(command)) return
        event.preventDefault()
        runFork(run(command.value))
      }

      yield* Effect.acquireRelease(
        Effect.sync(() => window.addEventListener("keydown", onKeyDown)),
        () => Effect.sync(() => window.removeEventListener("keydown", onKeyDown))
      )
    })
  )
