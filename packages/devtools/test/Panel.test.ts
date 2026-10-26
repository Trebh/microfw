import { assert, describe, it } from "@effect/vitest"
import { decodeHistoryJson } from "@mufw/core"
import { Context, Deferred, Effect, Exit, Layer, Option, Scope, Stream } from "effect"
import { Document } from "uhtml/dom"
import init from "uhtml/init"
import { Counter, Ports } from "../../core/test/fixtures/Counter.ts"
import { type ExportedFile, layerHistoryList, layerPanel } from "../src/index.ts"

interface DomNode {
  readonly localName?: string
  readonly textContent?: string | null
  readonly childNodes?: ArrayLike<DomNode>
  dispatchEvent(event: Event): boolean
}

const findElements = (node: DomNode, localName: string): Array<DomNode> => {
  const own = node.localName === localName ? [node] : []
  return own.concat(Array.from(node.childNodes ?? []).flatMap((child) => findElements(child, localName)))
}

const findElement = (node: DomNode, localName: string): DomNode | undefined => findElements(node, localName)[0]

const document = new Document()
const { render, html } = init(document as unknown as globalThis.Document)

const Marker = Context.Reference<string>("test/Marker", { defaultValue: () => "default" })

const initial = {
  seq: 0,
  at: 0,
  kind: "init" as const,
  proposal: Option.none(),
  model: { count: 0 },
  representation: { controlState: "low" as const, count: 0 }
}

/** A history whose `travelTo` is `travelTo`, so a test observes the fiber the row click started. */
const panelWithTravel = (travelTo: () => Effect.Effect<void>) => {
  const root = document.createElement("div") as unknown as Element
  const deps = Layer.mergeAll(
    Layer.succeed(Ports.HistoryPort, { records: Stream.make(initial), travelTo, replay: () => Effect.void }),
    Layer.succeed(Marker, "from-layer")
  )
  const layer = layerPanel(Counter, Ports, { root, render, html }).pipe(Layer.provideMerge(deps))
  return { root, layer }
}

const rowRendered = (root: Element): Effect.Effect<void> =>
  Effect.suspend(() =>
    findElement(root as unknown as DomNode, "li") === undefined ? Effect.yieldNow.pipe(Effect.andThen(rowRendered(root))) : Effect.void
  )

describe("layerPanel fibers started by the DOM", () => {
  it.effect("see the services provided to the layer", () => {
    const received = Deferred.makeUnsafe<string>()
    const { root, layer } = panelWithTravel(() =>
      Effect.gen(function*() {
        yield* Deferred.succeed(received, yield* Marker)
      })
    )
    return Effect.gen(function*() {
      yield* rowRendered(root)

      findElement(root as unknown as DomNode, "li")!.dispatchEvent(new Event("click"))

      assert.strictEqual(yield* Deferred.await(received), "from-layer")
    }).pipe(Effect.provide(layer))
  })

  it.effect("are interrupted when the layer scope closes", () => {
    const started = Deferred.makeUnsafe<void>()
    const interrupted = Deferred.makeUnsafe<void>()
    const { root, layer } = panelWithTravel(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        Effect.asVoid
      )
    )
    return Effect.gen(function*() {
      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(layer, scope)
      yield* rowRendered(root)
      findElement(root as unknown as DomNode, "li")!.dispatchEvent(new Event("click"))
      yield* Deferred.await(started)

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted)
    })
  })
})

const step = (seq: number, count: number) => ({
  seq,
  at: seq,
  kind: "step" as const,
  proposal: Option.some({ _tag: "Inc" as const, by: 1 }),
  model: { count },
  representation: { controlState: "low" as const, count }
})

const rowsRendered = (root: Element, rows: number): Effect.Effect<void> =>
  Effect.suspend(() =>
    findElements(root as unknown as DomNode, "li").length < rows
      ? Effect.yieldNow.pipe(Effect.andThen(rowsRendered(root, rows)))
      : Effect.void
  )

describe("layerPanel travel rows", () => {
  it.effect("show the seq in travelledTo, not the latest record with an equal model", () => {
    const root = document.createElement("div") as unknown as Element
    const travel = { ...step(3, 1), kind: "travel" as const, proposal: Option.none(), travelledTo: 1 }
    const records = Stream.make(initial, step(1, 1), step(2, 1), travel)
    const history = Layer.succeed(Ports.HistoryPort, { records, travelTo: () => Effect.void, replay: () => Effect.void })
    const layer = layerPanel(Counter, Ports, { root, render, html }).pipe(Layer.provideMerge(history))
    return Effect.gen(function*() {
      yield* rowsRendered(root, 4)

      const rows = findElements(root as unknown as DomNode, "li")

      assert.match(rows[3]!.textContent ?? "", /↩ 1 /)
    }).pipe(Effect.provide(layer))
  })
})

describe("layerPanel restore rows", () => {
  it.effect("label a restore as a snapshot", () => {
    const root = document.createElement("div") as unknown as Element
    const restore = { ...step(2, 7), kind: "restore" as const, proposal: Option.none() }
    const records = Stream.make(initial, step(1, 1), restore)
    const history = Layer.succeed(Ports.HistoryPort, { records, travelTo: () => Effect.void, replay: () => Effect.void })
    const layer = layerPanel(Counter, Ports, { root, render, html }).pipe(Layer.provideMerge(history))
    return Effect.gen(function*() {
      yield* rowsRendered(root, 3)

      const rows = findElements(root as unknown as DomNode, "li")

      assert.match(rows[2]!.textContent ?? "", /#2 restore snapshot → low/)
    }).pipe(Effect.provide(layer))
  })
})

describe("layerPanel across a restarted history", () => {
  it.effect("starts the rows over at a new init record", () => {
    const root = document.createElement("div") as unknown as Element
    const records = Stream.make(initial, step(1, 1), step(2, 2), initial, step(1, 1))
    const history = Layer.succeed(Ports.HistoryPort, { records, travelTo: () => Effect.void, replay: () => Effect.void })
    const layer = layerPanel(Counter, Ports, { root, render, html }).pipe(Layer.provideMerge(history))
    return Effect.gen(function*() {
      yield* rowsRendered(root, 2)
      yield* Effect.yieldNow

      const rows = findElements(root as unknown as DomNode, "li")

      assert.strictEqual(rows.length, 2)
    }).pipe(Effect.provide(layer))
  })
})

describe("layerHistoryList", () => {
  it.effect("a row click shows that record and does not travel", () => {
    const root = document.createElement("div") as unknown as Element
    const travelled = Deferred.makeUnsafe<void>()
    const records = Stream.make(initial, step(1, 1), step(2, 2))
    const history = Layer.succeed(Ports.HistoryPort, {
      records,
      travelTo: () => Deferred.succeed(travelled, undefined).pipe(Effect.asVoid),
      replay: () => Effect.void
    })
    const layer = layerHistoryList(Counter, Ports, { root, render, html }).pipe(Layer.provideMerge(history))
    return Effect.gen(function*() {
      yield* rowsRendered(root, 3)

      findElements(root as unknown as DomNode, "li")[1]!.dispatchEvent(new Event("click"))
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      const detail = findElement(root as unknown as DomNode, "pre")?.textContent ?? ""
      assert.deepStrictEqual(JSON.parse(detail).model, { count: 1 })
      assert.isFalse(yield* Deferred.isDone(travelled))
    }).pipe(Effect.provide(layer))
  })
})

describe("layerPanel export", () => {
  it.effect("saves the retained history as JSON that decodes back to the same records", () => {
    const root = document.createElement("div") as unknown as Element
    const saved = Deferred.makeUnsafe<ExportedFile>()
    const records = [initial, step(1, 1), step(2, 2)]
    const history = Layer.succeed(Ports.HistoryPort, {
      records: Stream.fromIterable(records),
      travelTo: () => Effect.void,
      replay: () => Effect.void
    })
    const layer = layerPanel(Counter, Ports, {
      root,
      render,
      html,
      save: (file) => Deferred.succeed(saved, file).pipe(Effect.asVoid)
    }).pipe(Layer.provideMerge(history))
    return Effect.gen(function*() {
      yield* rowsRendered(root, 3)

      findElement(root as unknown as DomNode, "button")!.dispatchEvent(new Event("click"))
      const file = yield* Deferred.await(saved)

      const decoded = yield* decodeHistoryJson(Counter)(file.json)
      assert.deepStrictEqual(decoded, records)
    }).pipe(Effect.provide(layer))
  })
})
