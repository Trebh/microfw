import { Option } from "effect"
import type { Representation, SeatView } from "../../domain/BoxOffice.ts"
import { type Checkpoint, HORATIO, LEASE_TIMEOUT_MILLIS, OPHELIA, type Side, Synced } from "./house.ts"
import { Stagehand, type Representation as StageRepresentation } from "./stagehand.ts"
import { append, emptyTape, type Logged, type Tape } from "./tape.ts"

/** Where one window stands in the log: the last entry it applied, the lease epoch it knows, and its model's fingerprint. */
export interface Applied {
  readonly sequence: number
  readonly epoch: number
  readonly key: string
}

export interface WindowScene {
  readonly patron: string
  readonly seats: Option.Option<Representation>
  readonly applied: Option.Option<Applied>
  readonly holdsChair: boolean
}

/** Everything the act's view shows, folded from the streams of the two windows, the log and the stage manager. */
export interface Scene {
  readonly a: WindowScene
  readonly b: WindowScene
  readonly stage: StageRepresentation
  readonly tape: Tape
  readonly onTheWire: number
  readonly now: number
}

export type SceneEvent =
  | { readonly _tag: "Seats"; readonly side: Side; readonly representation: Representation }
  | { readonly _tag: "Applied"; readonly side: Side; readonly applied: Applied }
  | { readonly _tag: "Chair"; readonly side: Side; readonly holds: boolean }
  | { readonly _tag: "Stage"; readonly representation: StageRepresentation }
  | { readonly _tag: "Logged"; readonly logged: Logged }
  | { readonly _tag: "OnTheWire"; readonly count: number }
  | { readonly _tag: "Now"; readonly at: number }

const seatKey = (seat: SeatView): string => `${seat.id}:${seat.status}:${Option.getOrElse(seat.by, () => "")}`

/** Two representations of one house are equal when this string is. */
const houseKey = (representation: Representation): string =>
  `${representation.controlState}|${representation.now}|${representation.seats.map(seatKey).join(",")}`

/** A checkpoint's model and sequence are one instant of one window, so the two cannot be read out of step. */
export const appliedOf = (checkpoint: Checkpoint): Applied => ({
  sequence: checkpoint.sequence,
  epoch: checkpoint.lease.epoch,
  key: houseKey(Synced.state(checkpoint.model))
})

const emptyWindow = (patron: string): WindowScene => ({
  patron,
  seats: Option.none(),
  applied: Option.none(),
  holdsChair: false
})

export const initialScene: Scene = {
  a: emptyWindow(HORATIO),
  b: emptyWindow(OPHELIA),
  stage: Stagehand.state(Stagehand.initial),
  tape: emptyTape,
  onTheWire: 0,
  now: 0
}

const inWindow = (scene: Scene, side: Side, change: (window: WindowScene) => WindowScene): Scene =>
  side === "A" ? { ...scene, a: change(scene.a) } : { ...scene, b: change(scene.b) }

const withStage = (scene: Scene, stage: StageRepresentation): Scene => {
  const closed = stage.controlState === "window-a-closed"
  return { ...scene, stage, a: closed ? { ...scene.a, holdsChair: false } : scene.a }
}

export const scene = (current: Scene, event: SceneEvent): Scene => {
  switch (event._tag) {
    case "Seats":
      return inWindow(current, event.side, (window) => ({ ...window, seats: Option.some(event.representation) }))
    case "Applied":
      return inWindow(current, event.side, (window) => ({ ...window, applied: Option.some(event.applied) }))
    case "Chair":
      return inWindow(current, event.side, (window) => ({ ...window, holdsChair: event.holds }))
    case "Stage":
      return withStage(current, event.representation)
    case "Logged":
      return { ...current, tape: append(current.tape, event.logged) }
    case "OnTheWire":
      return { ...current, onTheWire: event.count }
    case "Now":
      return { ...current, now: event.at }
  }
}

export type Agreement =
  | { readonly _tag: "agreed"; readonly sequence: number }
  | { readonly _tag: "catching-up"; readonly behind: Side; readonly sequence: number }
  | { readonly _tag: "diverged"; readonly sequence: number }
  | { readonly _tag: "alone" }
  | { readonly _tag: "joining" }

const compared = (a: Applied, b: Applied): Agreement => {
  if (a.sequence === b.sequence) {
    return a.key === b.key ? { _tag: "agreed", sequence: a.sequence } : { _tag: "diverged", sequence: a.sequence }
  }
  const behind = a.sequence < b.sequence ? "A" : "B"
  return { _tag: "catching-up", behind, sequence: Math.max(a.sequence, b.sequence) }
}

/** Equal models at the same sequence, or why not. Window A closed leaves nothing to agree with. */
export const agreement = (scene: Scene): Agreement => {
  if (scene.stage.controlState === "window-a-closed") return { _tag: "alone" }
  if (Option.isNone(scene.a.applied) || Option.isNone(scene.b.applied)) return { _tag: "joining" }
  return compared(scene.a.applied.value, scene.b.applied.value)
}

/** How long the log has gone without a lease entry that claimed or renewed. */
export const silenceMillis = (scene: Scene): Option.Option<number> =>
  Option.map(scene.tape.leaseAt, (at) => Math.max(0, scene.now - at))

/** The share of the lease timeout that silence has used up, from 0 to 1. */
export const silenceShare = (scene: Scene): number =>
  Math.min(1, Option.getOrElse(silenceMillis(scene), () => 0) / LEASE_TIMEOUT_MILLIS)

export const chairHolder = (scene: Scene): Option.Option<Side> => {
  if (scene.a.holdsChair) return Option.some("A")
  return scene.b.holdsChair ? Option.some("B") : Option.none()
}
