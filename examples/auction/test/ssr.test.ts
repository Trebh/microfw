import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { AutoActions, layerLoopLocal, type StepRecord } from "@mufw/core"
import { makeSsr } from "@mufw/view-uhtml/ssr"
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { HttpClient, HttpRouter } from "effect/http"
import { layerCreditCheckTable } from "../src/adapters/creditCheckTable.ts"
import { deployments } from "../src/deployments.ts"
import { Auction, initial, type Model, state } from "../src/auction/Auction.ts"
import { Amount, Bidder } from "../src/domain/Values.ts"
import { ServerPorts } from "../src/serverPorts.ts"
import { decodeSnapshot } from "../src/snapshot.ts"
import { AssetPath, renderApp, renderPage, ssrPages } from "../src/ssr.ts"
import { layerSsrRoutes } from "../src/ssrRoutes.ts"
import { pages } from "../scripts/pages.ts"

const ssr = makeSsr()

const record = (model: Model): StepRecord<typeof Auction> => ({
  seq: 0,
  at: 0,
  kind: "init",
  proposal: Option.none(),
  model,
  representation: state(model)
})

const alice = Bidder.make("alice")
const bid = { bidder: alice, amount: Amount.make(10), at: 500 }
const open: Model = { ...initial, phase: "open", now: 1000, endsAt: 61_000, highest: Option.some(bid), bids: [bid] }

/** The view of `initial` (opening, no bids) as uhtml serializes it, with `label` in the footer. */
const openingMarkup = (label: string) =>
  [
    "<!--<>--><header>",
    "      <h1>Vintage synth</h1>",
    "      <span class=\"badge opening\">opening</span>",
    "      <span class=\"remaining\">remaining: 60s</span>",
    "    </header>",
    "    <p class=\"highest\">highest: no bids</p>",
    "    <p class=\"opening\">",
    "        The auction is opening.",
    "        <button type=\"button\" class=\"open\">Open auction</button>",
    "      </p>",
    "    <form method=\"dialog\">",
    "      <input name=\"amount\" type=\"number\" disabled>",
    "      <button class=\"bid\" disabled>Place bid</button>",
    "    </form>",
    "    <p class=\"rejection\"></p>",
    "    <ol class=\"bids\"><!--[0]--></ol>",
    `    <footer>${label}</footer><!--</>-->`
  ].join("\n")

const SNAPSHOT_OPEN = "<script type=\"application/json\" id=\"mufw:auction\">"

const textOfSnapshot = (html: string) => html.split(SNAPSHOT_OPEN)[1]!.split("</script>")[0]!

describe("renderApp", () => {
  it("renders the representation's control state and bids as the browser's view does", () => {
    assert.strictEqual(renderApp(ssr, "L", state(initial)), openingMarkup("L"))
  })

  it("renders a form that cannot navigate before the bundle mounts its handler", () => {
    const markup = renderApp(ssr, "L", state(initial))

    assert.strictEqual(markup.match(/<form[^>]*>/)?.[0], "<form method=\"dialog\">")
  })
})

describe("renderPage", () => {
  it.effect("puts the view inside #app and keeps the rest of the template", () =>
    Effect.gen(function*() {
      const template = "<body><div id=\"app\"></div><script src=\"/assets/x.js\"></script></body>"

      const page = yield* renderPage(ssr, { deployment: "server-owned", template, record: record(initial), search: "" })

      assert.strictEqual(
        page,
        `<body><div id="app">${
          openingMarkup("model:server,actions:server · session demo-alice")
        }</div><script src="/assets/x.js"></script></body>`
      )
    }))

  it.effect("shows the live control state of the server's model", () =>
    Effect.gen(function*() {
      const page = yield* renderPage(ssr, {
        deployment: "server-owned",
        template: "<div id=\"app\"></div>",
        record: record(open),
        search: ""
      })

      assert.include(page, "<span class=\"badge open\">open</span>")
      assert.include(page, "<button class=\"bid\">Place bid</button>")
      assert.include(page, "<li>alice 10</li>")
    }))

  it.effect("labels the page with the identity in the request's query", () =>
    Effect.gen(function*() {
      const page = yield* renderPage(ssr, {
        deployment: "browser-only",
        template: "<div id=\"app\"></div>",
        record: record(initial),
        search: "?bidder=bob"
      })

      assert.include(page, "<footer>model:client,actions:client · bidder bob</footer>")
    }))

  it.effect("keeps `$` sequences of the markup as they are", () =>
    Effect.gen(function*() {
      const page = yield* renderPage(ssr, {
        deployment: "server-owned",
        template: "<div id=\"app\"></div>",
        record: record({ ...initial, item: "cost $1 $$ $&" }),
        search: ""
      })

      assert.include(page, "<h1>cost $1 $$ $&amp;</h1>")
    }))

  it.effect("fails when the template has no empty #app", () =>
    Effect.gen(function*() {
      const error = yield* renderPage(ssr, {
        deployment: "server-owned",
        template: "<body><div id=\"app\">taken</div></body>",
        record: record(initial),
        search: ""
      }).pipe(Effect.flip)

      assert.strictEqual(error._tag, "MissingAppRoot")
    }))
})

describe("the embedded model", () => {
  it.effect("decodes back to the model of the server's step", () =>
    Effect.gen(function*() {
      const page = yield* renderPage(ssr, {
        deployment: "browser-only",
        template: "<div id=\"app\"></div>",
        record: record(open),
        search: ""
      })

      assert.deepStrictEqual(yield* decodeSnapshot(textOfSnapshot(page)), open)
    }))

  it.effect("is written as plain JSON", () =>
    Effect.gen(function*() {
      const page = yield* renderPage(ssr, {
        deployment: "browser-only",
        template: "<div id=\"app\"></div>",
        record: record(open),
        search: ""
      })

      assert.strictEqual(
        textOfSnapshot(page),
        "{\"item\":\"Vintage synth\",\"minIncrement\":5,\"highest\":{\"_tag\":\"Some\",\"value\":{\"bidder\":\"alice\",\"amount\":10,\"at\":500}},\"bids\":[{\"bidder\":\"alice\",\"amount\":10,\"at\":500}],\"endsAt\":61000,\"now\":1000,\"phase\":\"open\",\"lastRejection\":{\"_tag\":\"None\"}}"
      )
    }))

  it.effect("cannot be closed early by a string of the model", () =>
    Effect.gen(function*() {
      const item = "</script><script>alert(1)</script>"

      const page = yield* renderPage(ssr, {
        deployment: "browser-only",
        template: "<div id=\"app\"></div>",
        record: record({ ...initial, item }),
        search: ""
      })

      assert.notInclude(page, "</script><script>alert(1)")
      assert.strictEqual((yield* decodeSnapshot(textOfSnapshot(page))).item, item)
    }))

  it.effect("is left out where the server owns the model", () =>
    Effect.gen(function*() {
      const page = yield* renderPage(ssr, {
        deployment: "server-model",
        template: "<div id=\"app\"></div>",
        record: record(open),
        search: ""
      })

      assert.notInclude(page, "application/json")
    }))
})

describe("AssetPath", () => {
  it.each(["browser-only-CB4ULYFj.js", "chunks/a.b-1_2.css"])("accepts %s", (path) => {
    assert.isTrue(Schema.is(AssetPath)(path))
  })

  it.each(["../browser-only.html", "/etc/passwd", "a/../../b", "..", ".", "", "a//b", "a/", "a\\b", "%2e%2e/b", "a\u0000b"])(
    "refuses %j",
    (path) => {
      assert.isFalse(Schema.is(AssetPath)(path))
    }
  )
})
describe("the deployments", () => {
  it("name the html file `scripts/pages.ts` lists for each page they render", () => {
    const files = Object.fromEntries(deployments.map((deployment) => [deployment, ssrPages[deployment].file]))
    const rendered = Object.fromEntries(Object.entries(pages).filter(([deployment]) => deployment in files))

    assert.deepStrictEqual(files, rendered)
  })

  it("leave out exactly the pages with no server-rendered auction view", () => {
    const notRendered = Object.keys(pages).filter((deployment) => !(deployment in ssrPages))

    assert.deepStrictEqual(notRendered, ["devtools", "worker"])
  })
})

class DistRoot extends Context.Service<DistRoot, string>()("test/DistRoot") {}

const TEMPLATE = "<html><body><div id=\"app\"></div><script src=\"/assets/app.js\"></script></body></html>"

/** A `dist` with one built deployment, in a directory that goes with the layer. */
const Dist = Layer.effect(DistRoot)(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped()
    yield* fs.makeDirectory(`${root}/browser-only/assets`, { recursive: true })
    yield* fs.writeFileString(`${root}/browser-only/browser-only.html`, TEMPLATE)
    yield* fs.writeFileString(`${root}/browser-only/assets/app.js`, "console.log(1)")
    return root
  })
)

const Loop = layerLoopLocal(Auction, ServerPorts).pipe(
  Layer.provide(layerCreditCheckTable),
  Layer.provide(Layer.succeed(AutoActions, false))
)

/** `serve` builds what it is given in a private memo map, so the loop is provided from outside to be shared with the test. */
const Routes = Layer.unwrap(
  DistRoot.use((distRoot) =>
    Effect.succeed(HttpRouter.serve(layerSsrRoutes({ deployment: "browser-only", distRoot }), { disableListenLog: true }))
  )
)

/** The routes over a real HTTP server on a free port, over a `Loop` the test also reaches. */
const Served = Routes.pipe(
  Layer.provideMerge(Loop),
  Layer.provideMerge(Dist.pipe(Layer.provide(NodeHttpServer.layerTest))),
  Layer.provideMerge(NodeHttpServer.layerTest)
)

const get = (path: string) =>
  Effect.gen(function*() {
    const response = yield* HttpClient.get(path)
    return { status: response.status, body: yield* response.text }
  })

describe("the routes", () => {
  it.effect("answer GET / with the page of the server's current view", () =>
    Effect.gen(function*() {
      const { status, body } = yield* get("/")

      assert.strictEqual(status, 200)
      assert.include(body, "<div id=\"app\"><!--<>--><header>")
      assert.include(body, "<span class=\"badge opening\">opening</span>")
      assert.include(body, "<script src=\"/assets/app.js\"></script></body></html>")
    }).pipe(Effect.provide(Served)))

  it.effect("follow the server's loop: a step shows in the next page and in its snapshot", () =>
    Effect.gen(function*() {
      yield* ServerPorts.ModelPort.use((port) => port.present({ _tag: "Opened", at: 1000 }))

      const { body } = yield* get("/")

      assert.include(body, "<span class=\"badge open\">open</span>")
      assert.include(textOfSnapshot(body), "\"phase\":\"open\"")
    }).pipe(Effect.provide(Served)))

  it.effect("serve a built asset", () =>
    Effect.gen(function*() {
      const { status, body } = yield* get("/assets/app.js")

      assert.deepStrictEqual([status, body], [200, "console.log(1)"])
    }).pipe(Effect.provide(Served)))

  it.effect("answer 404 for an asset that does not exist", () =>
    Effect.gen(function*() {
      const { status } = yield* get("/assets/missing.js")

      assert.strictEqual(status, 404)
    }).pipe(Effect.provide(Served)))

  it.effect("refuse an asset path that leaves the assets directory", () =>
    Effect.gen(function*() {
      const { status, body } = yield* get("/assets/..%2Fbrowser-only.html")

      assert.deepStrictEqual([status, body], [400, "Bad Request"])
    }).pipe(Effect.provide(Served)))
})
