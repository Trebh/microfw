import { assert, describe, it } from "@effect/vitest"
import { layerLoopLocal } from "@mufw/core"
import { Deferred, Effect, Layer, Queue } from "effect"
import { Document } from "uhtml/dom"
import init from "uhtml/init"
import { Counter, Ports } from "../../core/test/fixtures/Counter.ts"
import { inputBudgetMillis, layerInputScheduler, layerMount, type View } from "../src/index.ts"

interface DomNode {
  readonly localName?: string
  readonly childNodes?: ArrayLike<DomNode>
  dispatchEvent(event: Event): boolean
}

const findElement = (node: DomNode, localName: string): DomNode | undefined => {
  if (node.localName === localName) return node
  return Array.from(node.childNodes ?? []).map((child) => findElement(child, localName)).find(Boolean)
}

/** Runs `task` in the next macrotask. `setImmediate` runs in posting order, so a probe posted first runs first. */
const nextMacrotask = (task: () => void) => {
  setImmediate(task)
}

const spin = (millis: number) =>
  Effect.sync(() => {
    const end = performance.now() + millis
    while (performance.now() < end) {
      // busy: the fiber holds the thread
    }
  })

describe("layerInputScheduler", () => {
  it.effect("runs a fiber woken by a queue offer before the next macrotask", () =>
    Effect.gen(function*() {
      const order: Array<string> = []
      const queue = yield* Queue.unbounded<number>()
      const probed = Deferred.makeUnsafe<void>()
      const woken = Deferred.makeUnsafe<void>()
      yield* Effect.forkScoped(
        Queue.take(queue).pipe(
          Effect.andThen(Effect.sync(() => order.push("fiber"))),
          Effect.andThen(Deferred.succeed(woken, undefined))
        )
      )
      yield* Effect.yieldNow
      nextMacrotask(() => {
        order.push("macrotask")
        Deferred.doneUnsafe(probed, Effect.void)
      })

      yield* Queue.offer(queue, 1)
      yield* Deferred.await(woken)
      yield* Deferred.await(probed)

      assert.deepStrictEqual(order, ["fiber", "macrotask"])
    }).pipe(Effect.scoped, Effect.provide(layerInputScheduler)))

  it.effect("lets a macrotask run while a fiber keeps working", () => {
    const steps = 40
    const stepMillis = 1
    return Effect.gen(function*() {
      let completed = 0
      const probed = Deferred.makeUnsafe<number>()
      nextMacrotask(() => Deferred.doneUnsafe(probed, Effect.succeed(completed)))
      const step = spin(stepMillis).pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(Effect.sync(() => completed++))
      )

      yield* Effect.forEach(Array.from({ length: steps }), () => step, { discard: true })
      const completedWhenMacrotaskRan = yield* Deferred.await(probed)

      assert.isTrue(steps * stepMillis > inputBudgetMillis)
      assert.isBelow(completedWhenMacrotaskRan, steps)
    }).pipe(Effect.provide(layerInputScheduler))
  })
})

describe("a page on layerInputScheduler", () => {
  const document = new Document()
  const { render, html } = init(document as unknown as globalThis.Document)
  const view: View<typeof Counter.representation.Type, typeof Counter.intent.Type> = (representation, dispatch) =>
    html`<p>count: ${representation.count}</p>
      <button onclick=${() => dispatch({ _tag: "Inc", by: 1 })}>+</button>`

  const click = (root: Element) => {
    findElement(root as unknown as DomNode, "button")!.dispatchEvent(new Event("click"))
  }

  /**
   * Resumes once `root` shows its first paint, from a timer posted after that paint. Startup can
   * spend the scheduler's budget, and the timer that resets it is posted while the startup work
   * runs, so it has fired by then: the click starts with a full budget. The wait is ordering, not a
   * duration: `setTimeout(…, 0)` timers fire in posting order, while a `setImmediate` can run
   * before a pending one. Fake timers would replace the real queue the scheduler posts to.
   */
  const firstPaint = (root: Element) =>
    Effect.callback<void>((resume) => {
      const check = () => {
        const next = root.textContent ? () => resume(Effect.void) : check
        setTimeout(next, 0)
      }
      setTimeout(check, 0)
    })

  it.effect("shows the step of a click before the next macrotask", () => {
    const root = document.createElement("div") as unknown as Element
    const page = layerMount(Ports, { root, view, render, onRefused: () => Effect.void }).pipe(
      Layer.provideMerge(layerLoopLocal(Counter, Ports)),
      Layer.provide(layerInputScheduler)
    )
    return Effect.gen(function*() {
      yield* firstPaint(root)
      const shownAtMacrotask = Deferred.makeUnsafe<string | null>()

      nextMacrotask(() => Deferred.doneUnsafe(shownAtMacrotask, Effect.succeed(root.textContent)))
      click(root)
      const shown = yield* Deferred.await(shownAtMacrotask)

      assert.include(shown, "count: 1")
    }).pipe(Effect.provide(page))
  })
})
