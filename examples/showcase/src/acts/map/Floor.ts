import { Option } from "effect"
import type { Representation as BoxOfficeRepresentation } from "../../domain/BoxOffice.ts"
import { groupKey, type Leg } from "./Survey.ts"

export interface Point {
  readonly x: number
  readonly y: number
}

/** Where a control state stands on the floor, and the side its self-loops are chalked on (degrees, clockwise from the right). */
export interface SpikeMark extends Point {
  readonly loop: number
}

export const FLOOR = { width: 720, height: 430 } as const
export const NODE_RADIUS = 30

/** The only hand-placed thing on the map: the rest is drawn from the graph. */
const spikeMarks = {
  dark: { x: 92, y: 98, loop: -135 },
  selling: { x: 292, y: 286, loop: 140 },
  full: { x: 566, y: 118, loop: -35 },
  curtain: { x: 612, y: 340, loop: 30 }
} satisfies Record<BoxOfficeRepresentation["controlState"], SpikeMark>

const marksByName: Readonly<Record<string, SpikeMark>> = spikeMarks

export const markOf = (controlState: string): Option.Option<SpikeMark> =>
  Option.fromNullishOr(marksByName[controlState])

/** A chalk arc between two spike marks, or a loop on one, with where its label and arrow-head go. */
export interface Arc {
  readonly leg: Leg
  readonly key: string
  readonly d: string
  readonly label: Point
  readonly anchor: "start" | "middle" | "end"
  readonly head: Point & { readonly angle: number }
}

const CHORD_BEND = 0.1
const CHORD_MIN_BEND = 18
const CHORD_BEND_STEP = 30
const HEAD_GAP = 3
const LABEL_LIFT = 11
const LOOP_SPREAD = 36
const LOOP_HALF_WIDTH = 0.42
const LOOP_FLARE = 0.8
const LOOP_REACH = NODE_RADIUS * 2.6
const LOOP_REACH_ALTERNATE = NODE_RADIUS * 3.2
const LOOP_LABEL_LIFT = 13

const fixed = (value: number): string => value.toFixed(1)
const at = (point: Point): string => `${fixed(point.x)} ${fixed(point.y)}`
const radians = (degrees: number): number => (degrees * Math.PI) / 180
const degrees = (angle: number): number => (angle * 180) / Math.PI

const polar = (centre: Point, angle: number, distance: number): Point => ({
  x: centre.x + Math.cos(angle) * distance,
  y: centre.y + Math.sin(angle) * distance
})

const towards = (origin: Point, target: Point, distance: number): Point => {
  const length = Math.hypot(target.x - origin.x, target.y - origin.y)
  return { x: origin.x + ((target.x - origin.x) / length) * distance, y: origin.y + ((target.y - origin.y) / length) * distance }
}

const headAt = (end: Point, from: Point): Arc["head"] => ({
  ...end,
  angle: degrees(Math.atan2(end.y - from.y, end.x - from.x))
})

/** A quadratic arc; the first arc between two places bends one way, the one coming back bends the other. */
const chordArc = (leg: Leg, from: SpikeMark, to: SpikeMark, index: number): Arc => {
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  const normal = { x: -(to.y - from.y) / length, y: (to.x - from.x) / length }
  const bend = Math.max(CHORD_MIN_BEND, length * CHORD_BEND) + index * CHORD_BEND_STEP
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
  const control = { x: middle.x + normal.x * bend * 2, y: middle.y + normal.y * bend * 2 }
  const start = towards(from, control, NODE_RADIUS)
  const end = towards(to, control, NODE_RADIUS + HEAD_GAP)
  const apex = {
    x: 0.25 * start.x + 0.5 * control.x + 0.25 * end.x + normal.x * LABEL_LIFT,
    y: 0.25 * start.y + 0.5 * control.y + 0.25 * end.y + normal.y * LABEL_LIFT
  }
  return {
    leg,
    key: groupKey(leg),
    d: `M ${at(start)} Q ${at(control)} ${at(end)}`,
    label: apex,
    anchor: "middle",
    head: headAt(end, control)
  }
}

const anchorFor = (angle: number): Arc["anchor"] => {
  const side = Math.cos(angle)
  if (side > 0.35) return "start"
  return side < -0.35 ? "end" : "middle"
}

/** A cubic loop leaving and rejoining the ring; the loops of one place fan out and alternate in size. */
const loopArc = (leg: Leg, mark: SpikeMark, index: number, count: number): Arc => {
  const angle = radians(mark.loop + (index - (count - 1) / 2) * LOOP_SPREAD)
  const reach = index % 2 === 0 ? LOOP_REACH : LOOP_REACH_ALTERNATE
  const start = polar(mark, angle - LOOP_HALF_WIDTH, NODE_RADIUS)
  const end = polar(mark, angle + LOOP_HALF_WIDTH, NODE_RADIUS + HEAD_GAP)
  const first = polar(mark, angle - LOOP_FLARE, reach)
  const second = polar(mark, angle + LOOP_FLARE, reach)
  const apex = {
    x: (start.x + 3 * first.x + 3 * second.x + end.x) / 8,
    y: (start.y + 3 * first.y + 3 * second.y + end.y) / 8
  }
  return {
    leg,
    key: groupKey(leg),
    d: `M ${at(start)} C ${at(first)} ${at(second)} ${at(end)}`,
    label: polar(apex, angle, LOOP_LABEL_LIFT),
    anchor: anchorFor(angle),
    head: headAt(end, second)
  }
}

interface Placed {
  readonly leg: Leg
  readonly from: SpikeMark
  readonly to: SpikeMark
}

const placedOf = (leg: Leg): ReadonlyArray<Placed> => {
  const from = markOf(leg.from)
  const to = markOf(leg.to)
  return Option.isSome(from) && Option.isSome(to) ? [{ leg, from: from.value, to: to.value }] : []
}

/**
 * One arc per leg, in the order given. A leg touching a place that has no spike mark is not drawn.
 * Arcs that share their ends are told apart by their index among them.
 */
export const arcsOf = (legs: ReadonlyArray<Leg>): ReadonlyArray<Arc> => {
  const placed = legs.flatMap(placedOf)
  return placed.map((one) => {
    const siblings = placed.filter((other) => other.leg.from === one.leg.from && other.leg.to === one.leg.to)
    const index = siblings.indexOf(one)
    return one.leg.from === one.leg.to
      ? loopArc(one.leg, one.from, index, siblings.length)
      : chordArc(one.leg, one.from, one.to, index)
  })
}
