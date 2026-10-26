import { assert, describe, it } from "@effect/vitest"
import type { DispatchRefused, IntentPort, ModelPort, Path, PathStep } from "@mufw/core"
import { domDriver, makePainted } from "@mufw/test"
import { layerMount, type Render } from "@mufw/view-uhtml"
import { type Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import type { html as Html } from "uhtml"
import type { Auction, Intent } from "../src/auction/Auction.ts"
import { Ports } from "../src/ports.ts"
import { makeAuctionViewWith } from "../src/auction/Auction.view.ts"
import { auctionModel, clockedIntentDriver, clockFor, intentFor, Local, named } from "./auction/Auction.pathModel.ts"

/** What the test touches; uhtml's fake elements and real elements both have it. */
export interface DomNode {
  readonly textContent: string | null
  value?: string
  hasAttribute(name: string): boolean
  dispatchEvent(event: Event): boolean
  getElementsByClassName(className: string): ArrayLike<DomNode>
  getElementsByTagName(localName: string): ArrayLike<DomNode>
}

/** How a user acts on the rendered view: dispatched events on the fake DOM, real input in a browser. */
export interface Gestures {
  readonly click: (element: DomNode) => Effect.Effect<void>
  readonly fill: (input: DomNode, text: string) => Effect.Effect<void>
  /** Submits `form`; a browser does it by clicking `button`, the fake DOM has no default actions. */
  readonly submit: (form: DomNode, button: DomNode) => Effect.Effect<void>
}

/** A document, the uhtml bound to it and the way a user acts on it: uhtml's fake DOM or a browser's. */
export interface Harness {
  readonly html: typeof Html
  readonly render: Render
  /** A new element to mount the view into, attached wherever the harness shows it. */
  readonly createRoot: () => DomNode
  readonly gestures: Gestures
  /** How long each state stays on screen before the next step; zero when nobody watches. */
  readonly pace: Duration.Input
}

/** The mounted root, the gestures acting on it and the wait between steps. */
interface Page {
  readonly root: DomNode
  readonly gestures: Gestures
  readonly pause: Effect.Effect<void>
}

/** A missing element is an authoring bug of the view or of this test, not a path outcome. */
const first = (elements: ArrayLike<DomNode>, what: string): Effect.Effect<DomNode> => {
  const element = elements[0]
  return element === undefined ? Effect.die(new Error(`no ${what} in the rendered auction`)) : Effect.succeed(element)
}

const submitAmount = (page: Page, amount: number) =>
  Effect.gen(function*() {
    const input = yield* first(page.root.getElementsByTagName("input"), "<input>")
    const form = yield* first(page.root.getElementsByTagName("form"), "<form>")
    const button = yield* first(page.root.getElementsByClassName("bid"), "Place bid button")
    yield* page.gestures.fill(input, String(amount))
    yield* page.gestures.submit(form, button)
  })

/** The user gesture that dispatches `intent`, or `undefined` when the view offers none (`Tick`, `Close`). */
const userGesture = (page: Page, intent: Intent): Effect.Effect<void> | undefined => {
  if (intent._tag === "PlaceBid") return submitAmount(page, intent.amount)
  if (intent._tag !== "Open") return undefined
  return first(page.root.getElementsByClassName("open"), "Open auction button").pipe(
    Effect.flatMap(page.gestures.click)
  )
}

/** Performs the step through the rendered view; a step with no UI goes through the intent port. */
const actInDom = (page: Page) =>
(
  step: PathStep<typeof Auction>
): Effect.Effect<void, DispatchRefused, IntentPort<typeof Auction> | ModelPort<typeof Auction>> => {
  const gesture = userGesture(page, intentFor(step))
  const perform = gesture === undefined ? clockedIntentDriver.step(step) : clockFor(step).pipe(Effect.andThen(gesture))
  return page.pause.pipe(Effect.andThen(perform))
}

const bidButtonDisabled = (root: DomNode) => root.getElementsByClassName("bid")[0]?.hasAttribute("disabled")

const nodeShown: Record<string, ((root: DomNode) => void) | undefined> = {
  opening: (root) => assert.strictEqual(root.getElementsByClassName("open").length, 1, "Open auction button"),
  open: (root) => assert.strictEqual(bidButtonDisabled(root), false, "bid button disabled"),
  closing: (root) => assert.strictEqual(bidButtonDisabled(root), false, "bid button disabled"),
  sold: (root) => {
    assert.strictEqual(bidButtonDisabled(root), true, "bid button disabled")
    assert.strictEqual(root.getElementsByClassName("remaining")[0]?.textContent, "remaining: 0s")
  }
}

/** Throws while the rendered view does not show control state `node`. */
const showsIn = (root: DomNode) => (node: string) => {
  assert.strictEqual(root.getElementsByClassName("badge")[0]?.textContent, node, "badge")
  nodeShown[node]?.(root)
}

/** Replays every shortest and simple path of the auction through its rendered view. */
export const describeDomPaths = (harness: Harness) => {
  const view = makeAuctionViewWith(harness.html)("dom")
  const runInDom = (path: Path<typeof Auction>) =>
    Effect.gen(function*() {
      const painted = yield* makePainted
      const render: Render = painted.observe(harness.render)
      const root = harness.createRoot()
      // A person watches in wall-clock time, while the actions read the test clock.
      const pause = TestClock.withLive(Effect.sleep(harness.pace))
      const Mounted = layerMount(Ports, {
        // `root` is the element `createRoot` returned, an `Element` of the harness's document.
        root: root as unknown as Element,
        view,
        render,
        onRefused: () => Effect.void
      }).pipe(Layer.provideMerge(Local))
      const page: Page = { root, gestures: harness.gestures, pause }
      const driver = domDriver({ painted, act: actInDom(page), shows: showsIn(root) })
      yield* auctionModel.run(path, driver).pipe(Effect.provide(Mounted))
      yield* pause
    })
  describe("dom driver", () => {
    it.effect.each(named(auctionModel.shortestPaths))("shortest: $name", ({ path }) => runInDom(path))
    it.effect.each(named(auctionModel.simplePaths))("simple: $name", ({ path }) => runInDom(path))
  })
}
