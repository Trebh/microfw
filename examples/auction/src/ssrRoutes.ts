import type { StepRecord } from "@mufw/core"
import { makeSsr, type Ssr } from "@mufw/view-uhtml/ssr"
import { Effect, FileSystem, Option, Path, Schema, Stream, SubscriptionRef } from "effect"
import type { PlatformError } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { Deployment } from "./deployments.ts"
import type { Auction } from "./domain/Auction.ts"
import { ServerPorts } from "./serverPorts.ts"
import { AssetPath, type MissingAppRoot, renderPage, ssrPages } from "./ssr.ts"

/** Which built deployment the server renders and serves, and the directory that holds every `dist/<deployment>`. */
export interface SsrOptions {
  readonly deployment: Deployment
  readonly distRoot: string
}

/**
 * The latest step of the server's loop, read from `HistoryPort`: one record carries the model and
 * the representation computed from it, so a page never mixes the two of different steps. The
 * returned effect waits for the first record, which a local loop commits before it serves anything.
 */
const followLatest = Effect.gen(function*() {
  const history = yield* ServerPorts.HistoryPort
  const latest = yield* SubscriptionRef.make(Option.none<StepRecord<typeof Auction>>())
  yield* Effect.forkScoped(
    Stream.runForEach(history.records, (record) => SubscriptionRef.set(latest, Option.some(record)))
  )
  return SubscriptionRef.changes(latest).pipe(
    Stream.filter(Option.isSome),
    Stream.runHead,
    Effect.map(Option.flatten),
    Effect.flatMap(Option.match({
      onNone: () => Effect.die("the history port ended before its first record"),
      onSome: Effect.succeed
    }))
  )
})

const internalError = (error: unknown) =>
  Effect.logError("server-rendered page failed", error).pipe(
    Effect.as(HttpServerResponse.text("Internal Server Error", { status: 500 }))
  )

/** The page: the built html with the server's current view rendered into it. */
const servePage = (options: SsrOptions, ssr: Ssr, latest: Effect.Effect<StepRecord<typeof Auction>>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const request = yield* HttpServerRequest.HttpServerRequest
    const { deployment, distRoot } = options
    const template = yield* fs.readFileString(path.join(distRoot, deployment, ssrPages[deployment].file))
    const search = Option.match(HttpServerRequest.toURL(request), {
      onNone: () => "",
      onSome: (url) => url.search
    })
    const html = yield* renderPage(ssr, { deployment, template, record: yield* latest, search })
    return HttpServerResponse.html(html)
  }).pipe(Effect.catch(internalError))

const assetFailure = (error: PlatformError.PlatformError | Schema.SchemaError | MissingAppRoot) => {
  if (error._tag === "SchemaError") return Effect.succeed(HttpServerResponse.text("Bad Request", { status: 400 }))
  if (error._tag === "PlatformError" && error.reason._tag === "NotFound") {
    return Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 }))
  }
  return internalError(error)
}

/** A file below `dist/<deployment>/assets`, named by the route's wildcard, decoded as an `AssetPath` before it touches the file system. */
const serveAsset = (options: SsrOptions) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const params = yield* HttpRouter.params
    const asset = yield* Schema.decodeUnknownEffect(AssetPath)(params["*"])
    return yield* HttpServerResponse.file(path.join(options.distRoot, options.deployment, "assets", asset))
  }).pipe(Effect.catch(assetFailure))

/**
 * `GET /` answers with the built page of `options.deployment`, its view already rendered from the
 * server's loop, and `GET /assets/*` with that deployment's built assets. Needs the server's
 * `HistoryPort`; the file system and `HttpPlatform` are the HTTP server's.
 */
export const layerSsrRoutes = (options: SsrOptions) =>
  HttpRouter.use((router) =>
    Effect.gen(function*() {
      const latest = yield* followLatest
      const ssr = makeSsr()
      yield* router.add("GET", "/", servePage(options, ssr, latest))
      yield* router.add("GET", "/assets/*", serveAsset(options))
    })
  )
