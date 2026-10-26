import type { StepRecord } from "@mufw/core"
import type { Ssr } from "@mufw/view-uhtml/ssr"
import { Effect, Option, Schema } from "effect"
import { pageLabels } from "./client/labels.ts"
import { placements } from "./deployments.ts"
import type { Deployment, PlacedDeployment } from "./deployments.ts"
import type { Auction, Representation } from "./auction/Auction.ts"
import { AUCTION_SNAPSHOT_ID, encodeSnapshot } from "./snapshot.ts"
import { makeAuctionViewWith } from "./auction/Auction.view.ts"

/** What the server knows about a deployment's built page besides its label. */
interface SsrPage {
  /** The html file `vite build --mode <deployment>` writes into `dist/<deployment>`: the page's name in `scripts/pages.ts`. */
  readonly file: string
  /** The browser owns the auction model here, so the page carries a snapshot of the server's to start from. */
  readonly embedsModel: boolean
}

/** A page with a fixed placement carries the snapshot exactly when its model lives in the browser. */
const placedPage = (deployment: PlacedDeployment, file: string): SsrPage => ({
  file,
  embedsModel: placements[deployment].model === "client"
})

export const ssrPages: Readonly<Record<Deployment, SsrPage>> = {
  "demo": { file: "index.html", embedsModel: true },
  "browser-only": placedPage("browser-only", "browser-only.html"),
  "server-owned": placedPage("server-owned", "server-owned.html"),
  "server-model": placedPage("server-model", "server-model.html"),
  "server-actions": placedPage("server-actions", "server-actions.html")
}

/** Where the view goes: the empty root every page declares. */
const APP_ROOT = `<div id="app"></div>`

/** The built page has no empty `#app` to render into, so the template and the build disagree. */
export class MissingAppRoot extends Schema.TaggedError<MissingAppRoot>()("MissingAppRoot", {
  root: Schema.String
}) {}

/**
 * A file below `dist/<deployment>/assets`: one or more segments of letters, digits, `.`, `_` and
 * `-`, none of them `.` or `..`. A route parameter that is not one never reaches the file system,
 * so it cannot name a file outside the assets directory.
 */
export const AssetPath = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?!\.{1,2}(?:\/|$))[\w.-]+(?:\/(?!\.{1,2}(?:\/|$))[\w.-]+)*$/)),
  Schema.brand("AssetPath")
)
export type AssetPath = typeof AssetPath.Type

/** The markup of the auction view for `representation`, as the browser renders it first. */
export const renderApp = (ssr: Ssr, label: string, representation: Representation): string =>
  ssr.toString(makeAuctionViewWith(ssr.html)(label)(representation, () => {}))

/** The `<script>` element that carries the model; its text is escaped so no model string can leave it. */
const snapshotScript = (record: StepRecord<typeof Auction>) =>
  encodeSnapshot(record.model).pipe(
    Effect.map((text) => `<script type="application/json" id="${AUCTION_SNAPSHOT_ID}">${text}</script>`)
  )

/** `markup` inside `#app`, followed by the snapshot element when there is one. */
const fillTemplate = (template: string, markup: string, snapshot: Option.Option<string>) => {
  const at = template.indexOf(APP_ROOT)
  if (at < 0) return Effect.fail(new MissingAppRoot({ root: APP_ROOT }))
  const before = template.slice(0, at)
  const after = template.slice(at + APP_ROOT.length)
  return Effect.succeed(`${before}<div id="app">${markup}</div>${Option.getOrElse(snapshot, () => "")}${after}`)
}

/** The page of one request: what the server holds now, and the query string the page was asked with. */
export interface PageRequest {
  readonly deployment: Deployment
  /** The built html of the deployment. */
  readonly template: string
  /** The server's latest step: its representation is rendered, its model is embedded where the browser owns one. */
  readonly record: StepRecord<typeof Auction>
  /** The query string, with its `?`: the identity in the page's label comes from it. */
  readonly search: string
}

/** The built page with the view rendered into `#app` and, for a browser-model deployment, the model embedded. */
export const renderPage = (ssr: Ssr, request: PageRequest): Effect.Effect<string, MissingAppRoot | Schema.SchemaError> =>
  Effect.gen(function*() {
    const { deployment, template, record, search } = request
    const markup = renderApp(ssr, pageLabels[deployment](search), record.representation)
    const snapshot = ssrPages[deployment].embedsModel
      ? Option.some(yield* snapshotScript(record))
      : Option.none<string>()
    return yield* fillTemplate(template, markup, snapshot)
  })
