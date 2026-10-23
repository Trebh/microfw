import { readdirSync, readFileSync } from "node:fs"
import { join, posix, sep } from "node:path"
import ts from "typescript"

/** A module of the example: `path` is relative to the example's root, with `/` separators. */
export interface SourceFile {
  readonly path: string
  readonly text: string
}

/** A call that builds a local half of the auction in a module that must not. */
export interface MisplacedLocalHalf {
  readonly path: string
  readonly line: number
  readonly call: string
}

const CLIENT_DIRECTORY = "src/client/"

/** The one module of the client that builds the auction's local halves; pages compose its exports. */
const AUCTION_LOCAL = "src/client/placements/auctionLocal.ts"

const AUCTION_DEFINITION = "src/domain/Auction"

const CORE = "@mufw/core"
const LOCAL_BUILDERS: ReadonlySet<string> = new Set(["layerModelLocal", "layerActionRunnerLocal", "layerLoopLocal"])

/** What a module binds from one imported module: local names, namespace names, and which exports count. */
interface Imported {
  readonly locals: Set<string>
  readonly namespaces: Set<string>
  readonly exports: ReadonlySet<string>
}

const withoutExtension = (path: string) => path.replace(/\.ts$/, "")

const specifierOf = (declaration: ts.ImportDeclaration) =>
  ts.isStringLiteral(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : ""

const isAuctionDefinition = (from: string, specifier: string) =>
  specifier.startsWith(".") && withoutExtension(posix.join(posix.dirname(from), specifier)) === AUCTION_DEFINITION

const bindNamespace = (imported: Imported, bindings: ts.NamedImportBindings) => {
  if (ts.isNamespaceImport(bindings)) imported.namespaces.add(bindings.name.text)
  else {
    for (const element of bindings.elements) {
      const exported = (element.propertyName ?? element.name).text
      if (imported.exports.has(exported)) imported.locals.add(element.name.text)
    }
  }
}

/** The names a module binds from the modules `isSource` accepts, restricted to `exports`. */
const importedFrom = (file: ts.SourceFile, isSource: (specifier: string) => boolean, exports: ReadonlySet<string>) => {
  const imported: Imported = { locals: new Set(), namespaces: new Set(), exports }
  const declarations = file.statements.filter(ts.isImportDeclaration).filter((d) => isSource(specifierOf(d)))
  for (const declaration of declarations) {
    const bindings = declaration.importClause?.namedBindings
    if (bindings !== undefined) bindNamespace(imported, bindings)
  }
  return imported
}

/** Whether `node` reads one of the imported names, bare or through a namespace import. */
const refersTo = (node: ts.Node | undefined, imported: Imported): boolean => {
  if (node === undefined) return false
  if (ts.isIdentifier(node)) return imported.locals.has(node.text)
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && imported.namespaces.has(node.expression.text)
    && imported.exports.has(node.name.text)
}

/** `const A = Auction` makes `A` the auction too. */
const rememberAlias = (node: ts.Node, auction: Imported) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && refersTo(node.initializer, auction)) {
    auction.locals.add(node.name.text)
  }
}

const isLocalHalfOfAuction = (node: ts.CallExpression, builders: Imported, auction: Imported) =>
  refersTo(node.expression, builders) && refersTo(node.arguments[0], auction)

const misplacedIn = (source: SourceFile): ReadonlyArray<MisplacedLocalHalf> => {
  const file = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const builders = importedFrom(file, (specifier) => specifier === CORE, LOCAL_BUILDERS)
  const auction = importedFrom(file, (specifier) => isAuctionDefinition(source.path, specifier), new Set(["Auction"]))
  const found: Array<MisplacedLocalHalf> = []
  const visit = (node: ts.Node): void => {
    rememberAlias(node, auction)
    if (ts.isCallExpression(node) && isLocalHalfOfAuction(node, builders, auction)) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
      found.push({ path: source.path, line, call: node.expression.getText(file) })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const isClientModule = (source: SourceFile) => source.path.startsWith(CLIENT_DIRECTORY) && source.path !== AUCTION_LOCAL

/**
 * The calls in the client, outside `placements/auctionLocal.ts`, that build a local half of the
 * auction (`layerModelLocal`, `layerActionRunnerLocal`, `layerLoopLocal`) with the auction's
 * definition from `src/domain/Auction.ts`. The bundle check sees a half only through the exports of
 * `auctionLocal.ts`, so a half built anywhere else would reach a bundle that the check cannot
 * attribute to a deployment. The wallet's loop is built with the wallet's definition and is not
 * the auction's. The server composes its own halves at its composition root and is not in the client.
 *
 * Calls are found through the imports of `@mufw/core` and of the definition (named, aliased or
 * namespace) and `const` aliases of the definition in the same module; a definition re-exported
 * from another module is not followed.
 */
export const misplacedLocalHalves = (sources: ReadonlyArray<SourceFile>): ReadonlyArray<MisplacedLocalHalf> =>
  sources.filter(isClientModule).flatMap(misplacedIn)

/** Every TypeScript module under `src/client` of the example at `root`. */
export const clientSources = (root: string): ReadonlyArray<SourceFile> =>
  readdirSync(join(root, CLIENT_DIRECTORY), { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => {
      const path = `${CLIENT_DIRECTORY}${entry.split(sep).join("/")}`
      return { path, text: readFileSync(join(root, path), "utf8") }
    })
