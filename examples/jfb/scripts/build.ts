import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Schema } from "effect"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"
import { build } from "vite"
import { type Entry, ENTRIES, JFB_ROOT, JfbFailure, OUT_KEYED } from "./entries.ts"

const PackageVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

const failure = (message: string) => (error: unknown) => new JfbFailure({ message: `${message}: ${String(error)}` })

const readVersion = (path: string) =>
  Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: failure(`cannot read ${path}`) }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PackageVersion)),
    Effect.map((pkg) => pkg.version),
    Effect.mapError(failure(`no version in ${path}`))
  )

const CORE_PACKAGE = fileURLToPath(new URL("../../../packages/core/package.json", import.meta.url))
const UHTML_PACKAGE = fileURLToPath(new URL("../node_modules/uhtml/package.json", import.meta.url))

/** What JFB's results table calls the entry's framework version: µFW's own, or the installed uhtml's. */
const frameworkVersionOf = (entry: Entry) => readVersion(entry.versionOf === "mufw" ? CORE_PACKAGE : UHTML_PACKAGE)

/** One minified ES module with its dynamic imports inlined, so the directory holds exactly `dist/main.js`. */
const bundle = (entry: Entry, outDir: string) =>
  Effect.tryPromise({
    try: () =>
      build({
        root: JFB_ROOT,
        configFile: false,
        logLevel: "warn",
        publicDir: false,
        build: {
          outDir,
          emptyOutDir: true,
          minify: true,
          target: "esnext",
          modulePreload: false,
          rollupOptions: {
            input: join(JFB_ROOT, entry.source),
            output: { entryFileNames: "main.js", codeSplitting: false }
          }
        }
      }),
    catch: failure(`vite build of ${entry.name} failed`)
  })

const indexHtml = (entry: Entry) =>
  `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8"/>
    <title>${entry.title}</title>
    <link href="/css/currentStyle.css" rel="stylesheet"/>
</head>
<body>
<div id="main"></div>
<script type="module" src="dist/main.js"></script>
</body>
</html>
`

const frameworkPackage = (entry: Entry, version: string) => ({
  name: `js-framework-benchmark-${entry.name}`,
  version: "0.0.0",
  description: `${entry.name}: the js-framework-benchmark keyed table`,
  "js-framework-benchmark": {
    frameworkVersion: version,
    frameworkHomeURL: entry.homeURL,
    language: "TypeScript"
  },
  scripts: { dev: "exit 0", "build-prod": "exit 0" },
  license: "Apache-2.0"
})

/** JFB lists a directory only when a `package-lock.json` sits next to its `package.json`; nothing is installed in it. */
const frameworkLock = (entry: Entry) => ({
  name: `js-framework-benchmark-${entry.name}`,
  version: "0.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: { "": { name: `js-framework-benchmark-${entry.name}`, version: "0.0.0" } }
})

const writeJson = (path: string, value: unknown) =>
  Effect.tryPromise({
    try: () => writeFile(path, `${JSON.stringify(value, null, 2)}\n`),
    catch: failure(`cannot write ${path}`)
  })

const writeText = (path: string, text: string) =>
  Effect.tryPromise({ try: () => writeFile(path, text), catch: failure(`cannot write ${path}`) })

const kib = (bytes: number) => (bytes / 1024).toFixed(1)

const reportSize = (entry: Entry, mainPath: string) =>
  Effect.tryPromise({ try: () => readFile(mainPath), catch: failure(`cannot read ${mainPath}`) }).pipe(
    Effect.flatMap((code) => {
      const gzip = gzipSync(code, { level: 9 }).length
      const brotli = brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length
      return Console.log(
        `${entry.name}: dist/main.js ${kib(code.length)} KiB raw, ${kib(gzip)} KiB gzip, ${kib(brotli)} KiB brotli`
      )
    })
  )

const buildEntry = Effect.fnUntraced(function*(entry: Entry) {
  const entryDir = join(OUT_KEYED, entry.name)
  yield* Effect.tryPromise({
    try: () => rm(entryDir, { recursive: true, force: true }).then(() => mkdir(entryDir, { recursive: true })),
    catch: failure(`cannot reset ${entryDir}`)
  })
  yield* bundle(entry, join(entryDir, "dist"))
  const version = yield* frameworkVersionOf(entry)
  yield* writeText(join(entryDir, "index.html"), indexHtml(entry))
  yield* writeJson(join(entryDir, "package.json"), frameworkPackage(entry, version))
  yield* writeJson(join(entryDir, "package-lock.json"), frameworkLock(entry))
  yield* reportSize(entry, join(entryDir, "dist", "main.js"))
})

/** One production build per entry into `out/keyed/<name>`, each shaped like a built JFB framework directory. */
const program = Effect.forEach(ENTRIES, buildEntry, { discard: true })

NodeRuntime.runMain(program)
