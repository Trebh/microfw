/** One line of a composition root on show; a marked line is one that only this placement has. */
export interface CodeLine {
  readonly text: string
  readonly marked: boolean
}

const plain = (text: string): CodeLine => ({ text, marked: false })
const marked = (text: string): CodeLine => ({ text, marked: true })

/** Lines elided from the source: shown dimmed, never highlighted. */
export const ELISION = "…"

/** The lines of `placements.ts` that differ between the stages, dedented, with `…` where lines are left out. */
export const houseRoot: ReadonlyArray<CodeLine> = [
  marked("layerLoopLocal(house.def, house.ports).pipe("),
  plain("  Layer.provide(backstage)"),
  plain(")")
]

export const wingsRoot: ReadonlyArray<CodeLine> = [
  marked("Layer.provideMerge(workerProtocol),"),
  marked("Layer.provide(BrowserWorker.layer(spawnWings))"),
  plain(ELISION),
  marked("new Worker("),
  plain(`  new URL("./company.worker.ts", import.meta.url),`),
  plain(`  { type: "module" }`)
]

export const townRoot: ReadonlyArray<CodeLine> = [
  marked("townRpc.layerClientTest.pipe("),
  plain("  Layer.provide(townRpc.layerHandlers),"),
  plain("  Layer.provide(townLoop)"),
  plain(")"),
  plain(ELISION),
  marked("layerLatency(town, NETWORK_MILLIS)")
]

/** How the definition and the view are imported, for all three stages: `stages.ts` and `island.ts` carry these lines as they are. */
export const sharedImports: ReadonlyArray<string> = [
  `import { company } from "../../domain/BoxOffice.ts"`,
  `import { seatMap } from "./seatMap.ts"`
]

export type TokenKind = "plain" | "comment" | "string" | "keyword" | "type" | "number" | "call"

export interface Token {
  readonly kind: TokenKind
  readonly text: string
}

const TOKEN =
  /(\/\/.*$)|("(?:[^"\\]|\\.)*")|\b(import|from|new|const|type)\b|\b([A-Z][A-Za-z0-9]*)\b|\b(\d[\d_.]*)\b|([A-Za-z_$][\w$]*)(?=\()/g

/** Capture group n+1 of `TOKEN` is the kind at index n. */
const KINDS: ReadonlyArray<TokenKind> = ["comment", "string", "keyword", "type", "number", "call"]

const kindOf = (match: RegExpMatchArray): TokenKind => {
  const group = match.slice(1).findIndex((captured) => captured !== undefined)
  return KINDS[group] ?? "plain"
}

/** Splits a line into spans a stylesheet can colour; the tokens joined are the line again. */
export const tokenize = (line: string): ReadonlyArray<Token> => {
  const tokens: Array<Token> = []
  let cursor = 0
  for (const match of line.matchAll(TOKEN)) {
    const start = match.index
    if (start > cursor) tokens.push({ kind: "plain", text: line.slice(cursor, start) })
    tokens.push({ kind: kindOf(match), text: match[0] })
    cursor = start + match[0].length
  }
  if (cursor < line.length) tokens.push({ kind: "plain", text: line.slice(cursor) })
  return tokens
}
