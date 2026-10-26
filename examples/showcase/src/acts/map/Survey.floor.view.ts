import { Option } from "effect"
import { type Hole, svg } from "uhtml"
import type { Chart } from "./chart.ts"
import { type Arc, arcsOf, markOf, NODE_RADIUS, type SpikeMark } from "./floor.ts"
import { type Crossing, crossingNow, groupKey, type Leg, legMillis, type Representation } from "./Survey.ts"

const classes = (...parts: ReadonlyArray<string | false>): string => parts.filter((part) => part !== false).join(" ")

const fixed = (value: number): string => value.toFixed(1)

/** Floorboards: a line across the stage every few feet. */
const BOARDS = Array.from({ length: 10 }, (_, board) => `M 8 ${50 + board * 38} H 712`).join(" ")

/** The light travels for most of the time it is given, and rests for the remainder. */
const TRAVEL_SHARE = 0.9

type Kind = "explored" | "walked" | "missed"

const kindOf = (crossing: Crossing | undefined): Kind => {
  if (crossing === undefined) return "explored"
  return crossing.missed ? "missed" : "walked"
}

const edgeView = (
  arc: Arc,
  index: number,
  representation: Representation,
  crossings: ReadonlyMap<string, Crossing>,
  crossingKey: string
): Hole => {
  const crossing = crossings.get(arc.key)
  const kind = kindOf(crossing)
  const label = crossing === undefined ? arc.leg.tag : `${arc.leg.tag} ×${crossing.count}`
  const note = kind === "missed"
    ? svg`<text class="edge__note" x=${fixed(arc.label.x)} y=${fixed(arc.label.y + 13)} text-anchor=${arc.anchor}>exploration never tried this</text>`
    : null
  return svg`<g
    class=${classes("edge", `edge--${kind}`, arc.key === representation.latest && "is-latest", arc.key === crossingKey && "is-crossing")}
    data-spot=${`edge-${arc.leg.tag}-${arc.leg.from}-${arc.leg.to}`}
    style=${`--i:${index}`}
  >
    <path class="edge__line" d=${arc.d} pathLength="1" />
    <path class="edge__head" d="M -9 -5.5 L 0 0 L -9 5.5" transform=${`translate(${fixed(arc.head.x)} ${fixed(arc.head.y)}) rotate(${fixed(arc.head.angle)})`} />
    <text class="edge__tag" x=${fixed(arc.label.x)} y=${fixed(arc.label.y)} text-anchor=${arc.anchor}>${label}</text>
    ${note}
  </g>`
}

const crowdOf = (chart: Chart, node: string): number =>
  [...chart.graph.states.values()].filter((state) => state.key === node).length

const nodeView = (chart: Chart, name: string, mark: SpikeMark, representation: Representation): Hole =>
  svg`<g
    class=${classes("node", representation.standing === name && "is-standing")}
    data-spot=${`node-${name}`}
    transform=${`translate(${mark.x} ${mark.y})`}
  >
    <title>${`${name}: ${crowdOf(chart, name)} explored states`}</title>
    <circle class="node__ring" r=${NODE_RADIUS} />
    <path class="node__tape" d="M -20 -20 L 20 20 M 20 -20 L -20 20" />
    <text class="node__name" y="5" text-anchor="middle">${name}</text>
  </g>`

const nodesOf = (chart: Chart, representation: Representation): ReadonlyArray<Hole> =>
  [...chart.graph.nodes.keys()].flatMap((name) =>
    Option.toArray(Option.map(markOf(name), (mark) => nodeView(chart, name, mark, representation)))
  )

/** The light on the arc it crosses: a bright spark and a tail behind it, both slid along the arc by CSS. */
const lightOnArc = (arc: Arc, representation: Representation): Hole => {
  const parity = String(representation.taken % 2)
  const travel = `--travel:${Math.round(legMillis(representation) * TRAVEL_SHARE)}ms`
  return svg`<path class="walker__tail" d=${arc.d} pathLength="1" data-parity=${parity} style=${travel} />
    <path class="walker__spark" d=${arc.d} pathLength="1" data-parity=${parity} style=${travel} />`
}

const lightAtRest = (mark: SpikeMark): Hole =>
  svg`<circle class="walker__rest" cx=${fixed(mark.x)} cy=${fixed(mark.y)} r=${NODE_RADIUS + 7} />`

const walkerView = (arcs: ReadonlyArray<Arc>, representation: Representation): Hole | null => {
  if (representation.controlState !== "walking") return null
  const crossing = crossingNow(representation)
  if (Option.isSome(crossing)) {
    const arc = arcs.find((candidate) => candidate.key === groupKey(crossing.value))
    return arc === undefined ? null : lightOnArc(arc, representation)
  }
  const target = Option.fromNullishOr(representation.ways[representation.way]?.target)
  return Option.match(Option.flatMap(target, markOf), { onNone: () => null, onSome: lightAtRest })
}

/** Missed legs are drawn after the explored ones, so a new arc never shifts an arc already chalked. */
const drawnLegs = (chart: Chart, representation: Representation): ReadonlyArray<Leg> => [
  ...chart.legs,
  ...representation.crossings.filter((crossing) => crossing.missed)
]

/** The stage floor: boards, the explored arcs, the walked ones lit, the spike marks, and the light on its way. */
export const floorView = (chart: Chart, representation: Representation): Hole => {
  const arcs = arcsOf(drawnLegs(chart, representation))
  const crossings = new Map(
    representation.crossings.map((crossing): readonly [string, Crossing] => [groupKey(crossing), crossing])
  )
  const crossingKey = Option.match(crossingNow(representation), { onNone: () => "", onSome: groupKey })
  return svg`<svg class="floor" viewBox="0 0 720 430" role="img" aria-label="Map of the Box Office: four places to stand joined by chalk arcs">
    <defs>
      <radialGradient id="map-pool" cx="50%" cy="50%" r="50%">
        <stop class="floor__lit" offset="0" />
        <stop class="floor__dim" offset="1" />
      </radialGradient>
    </defs>
    <rect class="floor__deck" x="6" y="6" width="708" height="418" />
    <path class="floor__boards" d=${BOARDS} />
    <ellipse class="floor__pool" cx="360" cy="220" rx="330" ry="190" />
    <text class="floor__label" x="360" y="26" text-anchor="middle">upstage</text>
    <text class="floor__label" x="360" y="416" text-anchor="middle">downstage</text>
    <g class="floor__edges">${arcs.map((arc, index) => edgeView(arc, index, representation, crossings, crossingKey))}</g>
    <g class="floor__nodes">${nodesOf(chart, representation)}</g>
    <g class="walker">${walkerView(arcs, representation)}</g>
  </svg>`
}
