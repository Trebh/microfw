import type { Proposal as StageProposal } from "../../domain/BoxOffice.ts"

/** Where the quoted functions live. */
export const SOURCE_FILE = "src/domain/BoxOffice.ts"

export interface Quote {
  readonly name: string
  readonly code: string
}

const acceptDoorsOpened: Quote = {
  name: "acceptDoorsOpened",
  code: `export const acceptDoorsOpened = (model: Model, proposal: Proposed<"DoorsOpened">): Model =>
  model.phase === "dark" ? { ...model, phase: "selling", now: proposal.at } : model`
}

const acceptSeatHeld: Quote = {
  name: "acceptSeatHeld",
  code: `export const acceptSeatHeld = (model: Model, proposal: Proposed<"SeatHeld">): Model => {
  const closed = closedReason(model)
  if (Option.isSome(closed)) return refuse(model, closed.value)
  const place = placeOf(model, proposal.seat)
  if (!Option.exists(place, (found) => found._tag === "Free")) return refuse(model, \`\${proposal.seat} is taken\`)
  const held: Place = { _tag: "Held", seat: proposal.seat, by: proposal.by, until: proposal.at + HOLD_MILLIS }
  return {
    ...withPlace(model, held),
    now: Math.max(model.now, proposal.at),
    lastRefusal: Option.none()
  }
}`
}

const acceptSeatSold: Quote = {
  name: "acceptSeatSold",
  code: `export const acceptSeatSold = (model: Model, proposal: Proposed<"SeatSold">): Model => {
  const closed = closedReason(model)
  if (Option.isSome(closed)) return refuse(model, closed.value)
  const heldByBuyer = Option.exists(
    placeOf(model, proposal.seat),
    (found) => found._tag === "Held" && found.by === proposal.by
  )
  if (!heldByBuyer) return refuse(model, \`\${proposal.seat} is not held for \${proposal.by}\`)
  const sold: Place = { _tag: "Sold", seat: proposal.seat, by: proposal.by }
  return { ...withPlace(model, sold), lastRefusal: Option.none() }
}`
}

const acceptPaymentDeclined: Quote = {
  name: "acceptPaymentDeclined",
  code: `export const acceptPaymentDeclined = (model: Model, proposal: Proposed<"PaymentDeclined">): Model =>
  refuse(model, \`\${proposal.seat} was declined: \${proposal.reason}\`)`
}

const acceptTicked: Quote = {
  name: "acceptTicked",
  code: `export const acceptTicked = (model: Model, proposal: Proposed<"Ticked">): Model =>
  model.phase !== "dark" ? { ...model, now: Math.max(model.now, proposal.now) } : model`
}

const acceptCurtainRaised: Quote = {
  name: "acceptCurtainRaised",
  code: `/** The curtain rising lets go of every hold: nobody can pay once it is up. */
export const acceptCurtainRaised = (model: Model, proposal: Proposed<"CurtainRaised">): Model =>
  model.phase === "selling"
    ? { ...model, phase: "curtain", now: Math.max(model.now, proposal.at), seats: model.seats.map(release) }
    : model`
}

/** The acceptor that handles each proposal tag. */
export const acceptorFor: Readonly<Record<StageProposal["_tag"], Quote>> = {
  DoorsOpened: acceptDoorsOpened,
  SeatHeld: acceptSeatHeld,
  SeatSold: acceptSeatSold,
  PaymentDeclined: acceptPaymentDeclined,
  Ticked: acceptTicked,
  CurtainRaised: acceptCurtainRaised
}

export const reactor: Quote = {
  name: "releaseExpiredHolds",
  code: `/** Frees every hold whose time is up, after whatever proposal moved the clock. */
export const releaseExpiredHolds = (model: Model): Model => {
  const isExpired = (place: Place) => place._tag === "Held" && place.until <= model.now
  if (!model.seats.some(isExpired)) return model
  return { ...model, seats: model.seats.map((place) => (isExpired(place) ? release(place) : place)) }
}`
}

/** The acceptor a hold will meet, shown before the first proposal of the evening. */
export const firstAcceptor: Quote = acceptSeatHeld

/** A fragment of source and how to paint it. */
export interface Token {
  readonly text: string
  readonly kind: "plain" | "keyword" | "string" | "comment"
}

const PIECES = /(\/\*\*.*?\*\/|"[^"]*"|`[^`]*`|\b(?:export|const|return|if)\b)/

const kindOf = (piece: string): Token["kind"] => {
  if (piece.startsWith("/**")) return "comment"
  if (piece.startsWith("\"") || piece.startsWith("`")) return "string"
  return "keyword"
}

/** Splits one line of source into painted fragments: comments, strings, keywords and the rest. */
export const tokenize = (line: string): ReadonlyArray<Token> =>
  line
    .split(PIECES)
    .map((piece, index): Token => ({ text: piece, kind: index % 2 === 0 ? "plain" : kindOf(piece) }))
    .filter((token) => token.text !== "")
