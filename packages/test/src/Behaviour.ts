import {
  type AnyDefinition,
  applyProposal,
  type ExploredState,
  type Graph,
  type GraphTransition,
  type ModelOf,
  tagsOf
} from "@mufw/core"
import { Schema } from "effect"

/** One sampled proposal from one explored state. `changed` lists the top-level model fields whose encoded value differs. */
export interface BehaviourRow {
  readonly state: string
  readonly controlState: string
  readonly proposal: { readonly tag: string; readonly payload: unknown }
  readonly target: string
  readonly targetControlState: string
  readonly changed: ReadonlyArray<string>
}

/** A proposal tag of the schema that exploration never sampled from the state. */
export interface UntriedProposal {
  readonly state: string
  readonly tag: string
}

/** A model field that holds one encoded value in the stored model of every explored state. */
export interface ConstantField {
  readonly field: string
  readonly value: unknown
}

export interface BlindSpots {
  readonly untried: ReadonlyArray<UntriedProposal>
  readonly constant: ReadonlyArray<ConstantField>
}

type Fields = Readonly<Record<string, unknown>>

interface SampledTransition<D extends AnyDefinition> {
  readonly source: ExploredState<D>
  readonly transition: GraphTransition<D>
  readonly result: ModelOf<D>
}

const fieldsOf = (encodedModel: unknown): Fields => {
  const isRecord = typeof encodedModel === "object" && encodedModel !== null && !Array.isArray(encodedModel)
  if (!isRecord) throw new Error("mufw: behaviour: the model schema must encode to an object")
  return encodedModel as Fields
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const changedFields = (from: Fields, to: Fields): ReadonlyArray<string> => {
  const names = [...new Set([...Object.keys(from), ...Object.keys(to)])]
  return names.filter((name) => !sameValue(from[name], to[name]))
}

/** Every transition exploration sampled, in exploration order, with the model it produces. */
const sampledTransitions = <D extends AnyDefinition>(
  definition: D,
  graph: Graph<D>
): ReadonlyArray<SampledTransition<D>> =>
  [...graph.states.values()].flatMap((source) =>
    (graph.transitions.get(source.id) ?? []).map((transition) => ({
      source,
      transition,
      result: applyProposal(definition, source.model, transition.proposal)
    }))
  )

const proposalOf = (encodedProposal: Fields): BehaviourRow["proposal"] => {
  const { _tag, ...payload } = encodedProposal
  return { tag: String(_tag), payload }
}

/**
 * Per explored state and sampled proposal: the target state and the top-level model fields that
 * change, compared on the model schema's encoded form.
 */
export const behaviourOf = <D extends AnyDefinition>(
  definition: D,
  graph: Graph<D>
): ReadonlyArray<BehaviourRow> => {
  const encodeModel = Schema.encodeSync(definition.model)
  const encodeProposal = Schema.encodeSync(definition.proposal)
  return sampledTransitions(definition, graph).map(({ result, source, transition }) => ({
    state: source.id,
    controlState: source.representation.controlState,
    proposal: proposalOf(fieldsOf(encodeProposal(transition.proposal))),
    target: transition.to,
    targetControlState: graph.states.get(transition.to)!.representation.controlState,
    changed: changedFields(fieldsOf(encodeModel(source.model)), fieldsOf(encodeModel(result)))
  }))
}

const triedTags = <D extends AnyDefinition>(graph: Graph<D>, state: ExploredState<D>): ReadonlySet<string> =>
  new Set((graph.transitions.get(state.id) ?? []).map(({ proposal }) => proposal._tag))

const untriedOf = <D extends AnyDefinition>(definition: D, graph: Graph<D>): ReadonlyArray<UntriedProposal> => {
  const schemaTags = [...new Set(tagsOf(definition.proposal.ast))]
  return [...graph.states.values()].flatMap((state) => {
    const tried = triedTags(graph, state)
    return schemaTags.filter((tag) => !tried.has(tag)).map((tag) => ({ state: state.id, tag }))
  })
}

const constantOf = <D extends AnyDefinition>(definition: D, graph: Graph<D>): ReadonlyArray<ConstantField> => {
  const encodeModel = Schema.encodeSync(definition.model)
  const encoded = [...graph.states.values()].map((state) => fieldsOf(encodeModel(state.model)))
  const [initial] = encoded
  return Object.keys(initial!)
    .filter((field) => encoded.every((fields) => sameValue(fields[field], initial![field])))
    .map((field) => ({ field, value: initial![field] }))
}

/**
 * What exploration cannot say: the state and proposal-tag pairs it never tried, and the model
 * fields that hold one encoded value in the stored model of every explored state. Samples are
 * applied to those stored models, so a field listed here was never sampled against any other
 * value, even when transitions change it in their results.
 */
export const blindSpots = <D extends AnyDefinition>(definition: D, graph: Graph<D>): BlindSpots => ({
  untried: untriedOf(definition, graph),
  constant: constantOf(definition, graph)
})

const code = (text: string): string => `\`${text}\``

/** A table cell: a literal `|` would end it. */
const cell = (text: string): string => text.replaceAll("|", "\\|")

const proposalCell = ({ proposal }: BehaviourRow): string => {
  const hasPayload = Object.keys(proposal.payload as Fields).length > 0
  return cell(code(hasPayload ? `${proposal.tag} ${JSON.stringify(proposal.payload)}` : proposal.tag))
}

const stateLabel = (id: string, controlState: string): string => `${id} [${controlState}]`

const changedCell = (row: BehaviourRow): string => (row.changed.length === 0 ? "—" : row.changed.join(", "))

const rowLine = (row: BehaviourRow): string =>
  `| ${proposalCell(row)} | ${cell(stateLabel(row.target, row.targetControlState))} | ${cell(changedCell(row))} |`

const TABLE_HEAD = ["| proposal | → state | fields that change |", "| --- | --- | --- |"]

const stateSection = (rows: ReadonlyArray<BehaviourRow>): string => {
  const { controlState, state } = rows[0]!
  return [`## ${stateLabel(state, controlState)}`, "", ...TABLE_HEAD, ...rows.map(rowLine)].join("\n")
}

const emptyStateSection = <D extends AnyDefinition>(state: ExploredState<D>): string =>
  [`## ${stateLabel(state.id, state.representation.controlState)}`, "", "No proposal sampled."].join("\n")

const sectionsOf = <D extends AnyDefinition>(
  graph: Graph<D>,
  rows: ReadonlyArray<BehaviourRow>
): ReadonlyArray<string> =>
  [...graph.states.values()].map((state) => {
    const own = rows.filter((row) => row.state === state.id)
    return own.length === 0 ? emptyStateSection(state) : stateSection(own)
  })

const bullets = (items: ReadonlyArray<string>): ReadonlyArray<string> =>
  items.length === 0 ? ["none"] : items.map((item) => `- ${item}`)

const blindSpotsSection = (spots: BlindSpots): string =>
  [
    "## Blind spots",
    "",
    "### Untried proposals",
    "",
    ...bullets(spots.untried.map(({ state, tag }) => `${code(state)}: ${code(tag)}`)),
    "",
    "### Fields with one value in every explored state",
    "",
    ...bullets(spots.constant.map(({ field, value }) => `${code(field)}: ${code(JSON.stringify(value))}`))
  ].join("\n")

const headerOf = (name: string): string =>
  [
    `# Behaviour of ${name}`,
    "",
    `> Generated by \`renderBehaviour\` from the explore samples of \`${name}\`; \`vitest -u\` rewrites it. ` +
    "It shows only the proposals exploration sampled, applied to the model each explored state stores."
  ].join("\n")

/**
 * The behaviour card of a definition: one table per explored state, then the blind spots.
 * Deterministic: exploration order, encoded JSON in schema order, no timestamps.
 */
export const renderBehaviour = <D extends AnyDefinition>(definition: D, graph: Graph<D>): string => {
  const sections = [
    headerOf(definition.name),
    ...sectionsOf(graph, behaviourOf(definition, graph)),
    blindSpotsSection(blindSpots(definition, graph))
  ]
  return `${sections.join("\n\n")}\n`
}
