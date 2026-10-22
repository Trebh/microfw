import { Effect, Option, Schema } from "effect"
import { layerTimeTravel, runPage } from "./app.ts"
import { pageLabels } from "./labels.ts"
import { parseIdentity, parsePlacement, parseWalletOwner } from "./placement.ts"
import { browserOnly } from "./placements/browserOnly.ts"
import { httpReadOnly } from "./placements/httpReadOnly.ts"
import { serverActions } from "./placements/serverActions.ts"
import { serverModel } from "./placements/serverModel.ts"
import { serverOwned } from "./placements/serverOwned.ts"
import { socketReadOnly } from "./placements/socketReadOnly.ts"
import { runStreamFrame } from "./streamEmbed.ts"
import { runTicker, type TickerTransport } from "./ticker.ts"

const identity = parseIdentity(location.search)

/** The demo page picks any placement from the URL at runtime, so it bundles all four. */
const placements = {
  "client/client": () => browserOnly(identity.bidder),
  "server/server": () => serverOwned(identity.session),
  "server/client": () => serverModel(identity.bidder),
  "client/server": () => serverActions(identity.session)
}

const placement = parsePlacement(location.search)

runPage(
  placements[`${placement.model}/${placement.actions}`](),
  pageLabels["demo"](location.search),
  layerTimeTravel(),
  parseWalletOwner(placement.actions, location.search)
)

/**
 * How the ticker reads the server's auction, by the name in `?ticker=`. HTTP is the default: it
 * needs no socket, and the endpoint it reads serves `Representations` and nothing else whatever
 * `MUFW_RPCS` says (`pnpm --filter @mufw/example-auction compare:transports`, docs/architecture/placement.md).
 */
const TickerName = Schema.Literals(["http", "socket"])

const DEFAULT_TICKER: typeof TickerName.Type = "http"

const tickerTransports: Record<typeof TickerName.Type, TickerTransport> = {
  http: { placement: httpReadOnly, source: "the server's auction · read-only over HTTP" },
  socket: { placement: socketReadOnly, source: "the server's auction · read-only over the websocket" }
}

const TickerQuery = Schema.fromURLSearchParams(Schema.Struct({
  ticker: TickerName.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_TICKER)))
}))

const tickerName = Schema.decodeUnknownOption(TickerQuery)(new URLSearchParams(location.search)).pipe(
  Option.map((query) => query.ticker),
  Option.getOrElse(() => DEFAULT_TICKER)
)

runTicker(document.getElementById("ticker")!, tickerTransports[tickerName])
runStreamFrame(document.getElementById("stream")!)
