import type { XStateDefinition } from "@mufw/core"

/** What an XState config is made of: strings, lists and keyed objects. */
type Json = string | ReadonlyArray<Json> | { readonly [key: string]: Json }

/** A line that fits on the card keeps its nested objects on one line; a longer one opens out. */
const LINE_LIMIT = 46

const inline = (value: Json): string => {
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`
  const entries = Object.entries(value).map(([key, nested]) => `${JSON.stringify(key)}: ${inline(nested)}`)
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`
}

const childrenOf = (value: ReadonlyArray<Json> | { readonly [key: string]: Json }) =>
  Array.isArray(value)
    ? value.map((nested): readonly [string | null, Json] => [null, nested])
    : Object.entries(value).map(([key, nested]): readonly [string | null, Json] => [key, nested])

const entryLines = (key: string | null, value: Json, depth: number, comma: string): ReadonlyArray<string> => {
  const pad = "  ".repeat(depth)
  const head = key === null ? pad : `${pad}${JSON.stringify(key)}: `
  const flat = `${head}${inline(value)}${comma}`
  if (flat.length <= LINE_LIMIT || typeof value === "string") return [flat]
  const children = childrenOf(value)
  const body = children.flatMap(([childKey, child], index) =>
    entryLines(childKey, child, depth + 1, index < children.length - 1 ? "," : "")
  )
  const [open, close] = Array.isArray(value) ? (["[", "]"] as const) : (["{", "}"] as const)
  return [`${head}${open}`, ...body, `${pad}${close}${comma}`]
}

const jsonOf = (definition: XStateDefinition): Json => ({
  id: definition.id,
  initial: definition.initial,
  states: Object.fromEntries(Object.entries(definition.states).map(([name, node]) => [name, { on: node.on }]))
})

/** The lines of a machine config, indented by two spaces, as it is read on the card. */
export const printXState = (definition: XStateDefinition): ReadonlyArray<string> =>
  entryLines(null, jsonOf(definition), 0, "")

export interface Token {
  readonly kind: "key" | "string" | "plain"
  readonly text: string
}

const QUOTED = /"(?:[^"\\]|\\.)*"/g

/** A quoted string followed by a colon is a key; any other is a value; the rest is punctuation and indentation. */
export const tokensOf = (line: string): ReadonlyArray<Token> => {
  const tokens: Array<Token> = []
  let at = 0
  for (const match of line.matchAll(QUOTED)) {
    const start = match.index ?? at
    const end = start + match[0].length
    if (start > at) tokens.push({ kind: "plain", text: line.slice(at, start) })
    tokens.push({ kind: line.startsWith(":", end) ? "key" : "string", text: match[0] })
    at = end
  }
  if (at < line.length) tokens.push({ kind: "plain", text: line.slice(at) })
  return tokens
}
