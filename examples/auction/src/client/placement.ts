import { Effect, Option, Schema, SchemaTransformation } from "effect"
import { Bidder, SessionToken } from "../domain/Values.ts"

const Side = Schema.Literals(["client", "server"])
export type Side = typeof Side.Type

const DEFAULT_SIDE: Side = "client"

const sideOrDefault = Side.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_SIDE)))

const Placement = Schema.Struct({ model: sideOrDefault, actions: sideOrDefault })
export type Placement = typeof Placement.Type

const DEFAULT_PLACEMENT: Placement = { model: DEFAULT_SIDE, actions: DEFAULT_SIDE }
const DEFAULT_BIDDER = Bidder.make("alice")
const DEFAULT_SESSION = SessionToken.make("demo-alice")

/** `model:server,actions:client`, in any order; a missing side is `client`, an unknown side or name is a failure. */
const PlacementParam = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Record(Schema.String, Schema.String),
    SchemaTransformation.splitKeyValue({ separator: ",", keyValueSeparator: ":" })
  ),
  Schema.decodeTo(Placement)
)

const PlacementQuery = Schema.fromURLSearchParams(Schema.Struct({
  placement: PlacementParam.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_PLACEMENT)))
}))

const BidderQuery = Schema.fromURLSearchParams(Schema.Struct({
  bidder: Bidder.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_BIDDER)))
}))

const ExplicitBidderQuery = Schema.fromURLSearchParams(Schema.Struct({ bidder: Schema.optionalKey(Bidder) }))

const SessionQuery = Schema.fromURLSearchParams(Schema.Struct({
  session: SessionToken.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_SESSION)))
}))

/** Demo page only: parses `?placement=model:server,actions:client`; a missing query is `client`/`client`, an invalid one too. */
export const parsePlacement = (search: string): Placement =>
  Schema.decodeUnknownOption(PlacementQuery)(new URLSearchParams(search)).pipe(
    Option.map((query) => query.placement),
    Option.getOrElse(() => DEFAULT_PLACEMENT)
  )

/**
 * `?bidder=bob`: the identity of a page whose actions run in the browser, which vouches for itself
 * because the server already applies whatever that browser presents. A missing or empty name is `alice`.
 */
export const parseBidder = (search: string): Bidder =>
  Schema.decodeUnknownOption(BidderQuery)(new URLSearchParams(search)).pipe(
    Option.map((query) => query.bidder),
    Option.getOrElse(() => DEFAULT_BIDDER)
  )

/** `?bidder=bob` only when the URL states a valid one; a missing, empty or invalid name is `None`, never a default. */
const parseExplicitBidder = (search: string): Option.Option<Bidder> =>
  Schema.decodeUnknownOption(ExplicitBidderQuery)(new URLSearchParams(search)).pipe(
    Option.flatMapNullishOr((query) => query.bidder)
  )

/**
 * `?session=demo-bob`: the token a page whose actions run on the server sends; the server decides
 * who it belongs to. A missing or empty token is `demo-alice`.
 */
export const parseSession = (search: string): SessionToken =>
  Schema.decodeUnknownOption(SessionQuery)(new URLSearchParams(search)).pipe(
    Option.map((query) => query.session),
    Option.getOrElse(() => DEFAULT_SESSION)
  )

/** Who a page speaks for: the bidder where it runs the actions, the session where the server does. */
export interface Identity {
  readonly bidder: Bidder
  readonly session: SessionToken
}

export const parseIdentity = (search: string): Identity => ({
  bidder: parseBidder(search),
  session: parseSession(search)
})

/** What a page shows about its identity; only the one its actions' side uses counts. */
export const describeIdentity = (actions: Side, identity: Identity) =>
  actions === "server" ? `session ${identity.session}` : `bidder ${identity.bidder}`

/** Whose leading bids the wallet island reserves for; `None` is a wallet that follows nobody. */
export type WalletOwner = Option.Option<Bidder>

const walletOwnerOf: Record<Side, (search: string) => WalletOwner> = {
  // The browser runs the actions, so `?bidder=` (default `alice`) is the identity of the page too.
  client: (search) => Option.some(parseBidder(search)),
  // The server decides whose a session is and never tells the page, so only an explicit `?bidder=` names the owner.
  server: parseExplicitBidder
}

/** The wallet's owner, decided by the side that runs the page's actions. */
export const parseWalletOwner = (actions: Side, search: string): WalletOwner => walletOwnerOf[actions](search)

export const formatPlacement = (placement: Placement) => `model:${placement.model},actions:${placement.actions}`
