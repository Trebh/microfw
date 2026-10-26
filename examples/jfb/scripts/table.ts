import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

/** A file that cannot be read as a JFB result, or a set of files that cannot be tabulated. The message names the file. */
class ResultsError extends Error {}

interface Benchmark {
  readonly name: string
  readonly header: string
  readonly weight: number
}

interface Group {
  readonly title: string
  readonly type: "cpu" | "memory" | "size"
  /** Key of `values` that holds the median: CPU files store `total`, `script` and `paint`; the others `DEFAULT`. */
  readonly valueKey: "total" | "DEFAULT"
  readonly benchmarks: ReadonlyArray<Benchmark>
  /** `factor` prints the median over the smallest median of the set; `value` prints the median as stored. */
  readonly cells: "factor" | "value"
  readonly digits: number
}

/**
 * The CPU weights are those of `computeGeometricMean` in js-framework-benchmark
 * `webdriver-ts-results/src/Common.ts` (commit 3ab4cea); the other types use weight 1 there.
 */
const CPU: Group = {
  title: "CPU",
  type: "cpu",
  valueKey: "total",
  benchmarks: [
    { name: "01_run1k", header: "create 1k", weight: 0.64280248137063 },
    { name: "02_replace1k", header: "replace", weight: 0.5607178150466176 },
    { name: "03_update10th1k_x16", header: "update 10th", weight: 0.5643800750716564 },
    { name: "04_select1k", header: "select", weight: 0.1925635870170522 },
    { name: "05_swap1k", header: "swap", weight: 0.13200612879341714 },
    { name: "06_remove-one-1k", header: "remove", weight: 0.5277091212292658 },
    { name: "07_create10k", header: "create 10k", weight: 0.5644449600965534 },
    { name: "08_create1k-after1k_x2", header: "append", weight: 0.5508359820582848 },
    { name: "09_clear1k_x8", header: "clear", weight: 0.4225836631419211 }
  ],
  cells: "factor",
  digits: 2
}

const RUN_CLEAR_MEMORY = "25_run-clear-memory"

const MEMORY: Group = {
  title: "Memory",
  type: "memory",
  valueKey: "DEFAULT",
  benchmarks: [
    { name: "21_ready-memory", header: "ready", weight: 1 },
    { name: "22_run-memory", header: "after 1,000 rows", weight: 1 },
    { name: RUN_CLEAR_MEMORY, header: "after create and clear ×5", weight: 1 }
  ],
  cells: "value",
  digits: 3
}

const BROTLI = "42_size-compressed"
const FIRST_PAINT = "43_first-paint"

const SIZE: Group = {
  title: "Size and first paint",
  type: "size",
  valueKey: "DEFAULT",
  benchmarks: [
    { name: "41_size-uncompressed", header: "uncompressed KiB", weight: 1 },
    { name: BROTLI, header: "brotli KiB", weight: 1 },
    { name: FIRST_PAINT, header: "first paint ms", weight: 1 }
  ],
  cells: "value",
  digits: 1
}

const GROUPS: ReadonlyArray<Group> = [CPU, MEMORY, SIZE]
const BASELINE = "vanillajs"

interface Sample {
  readonly file: string
  readonly median: number
  readonly count: number
}

/** Entry short name -> benchmark name -> sample. */
type Results = Map<string, Map<string, Sample>>

interface Row {
  readonly entry: string
  readonly medians: ReadonlyArray<number>
  readonly factors: ReadonlyArray<number>
  readonly geomean: number
  readonly rank: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const fail = (file: string, reason: string): never => {
  throw new ResultsError(`${file}: ${reason}`)
}

const parseJson = (file: string, text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch (error) {
    return fail(file, `not valid JSON (${String(error)})`)
  }
}

const stringField = (file: string, json: Record<string, unknown>, key: string): string => {
  const value = json[key]
  return typeof value === "string" ? value : fail(file, `\`${key}\` is not a string`)
}

const sampleOf = (file: string, values: unknown, valueKey: string): Sample => {
  const stat = isRecord(values) ? values[valueKey] : undefined
  if (!isRecord(stat)) return fail(file, `\`values.${valueKey}\` is missing`)
  const { median, values: samples } = stat
  if (typeof median !== "number" || !Number.isFinite(median)) return fail(file, `\`values.${valueKey}.median\` is not a number`)
  if (!Array.isArray(samples) || samples.length === 0) return fail(file, `\`values.${valueKey}.values\` has no samples`)
  return { file, median, count: samples.length }
}

/** `react-zustand-v19.0.0 + 5.0.2-keyed` -> `react-zustand`; `vanillajs-keyed` -> `vanillajs`. */
const entryName = (framework: string): string => framework.replace(/-keyed$/, "").replace(/-v\d.*$/, "")

interface Parsed {
  readonly entry: string
  readonly benchmark: string
  readonly sample: Sample
}

/** `undefined` when the benchmark is not one of the tabulated ones. */
const parseFile = (file: string, text: string): Parsed | undefined => {
  const json = parseJson(file, text)
  if (!isRecord(json)) return fail(file, "not a JSON object")
  const framework = stringField(file, json, "framework")
  const benchmark = stringField(file, json, "benchmark")
  const type = stringField(file, json, "type")
  if (file !== `${framework}_${benchmark}.json`) return fail(file, `holds ${framework} / ${benchmark}, which the file name does not say`)
  const group = GROUPS.find((candidate) => candidate.benchmarks.some((known) => known.name === benchmark))
  if (group === undefined) return undefined
  if (group.type !== type) return fail(file, `\`type\` is ${type}, expected ${group.type}`)
  return { entry: entryName(framework), benchmark, sample: sampleOf(file, json.values, group.valueKey) }
}

const addSample = (results: Results, { entry, benchmark, sample }: Parsed): void => {
  const samples = results.get(entry) ?? new Map<string, Sample>()
  const earlier = samples.get(benchmark)
  if (earlier !== undefined) fail(sample.file, `${entry} / ${benchmark} is already in ${earlier.file}`)
  samples.set(benchmark, sample)
  results.set(entry, samples)
}

const resultFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.endsWith(".json"))
    .map((item) => item.name)
    .sort()

const loadResults = (dir: string): Results => {
  const results: Results = new Map()
  for (const file of resultFiles(dir)) {
    const parsed = parseFile(file, readFileSync(join(dir, file), "utf8"))
    if (parsed !== undefined) addSample(results, parsed)
  }
  return results
}

const requireComplete = (results: Results): void => {
  if (results.size === 0) throw new ResultsError("no result file for a tabulated benchmark in the directory")
  const expected = GROUPS.flatMap((group) => group.benchmarks.map((benchmark) => benchmark.name))
  for (const [entry, samples] of results) {
    const missing = expected.find((name) => !samples.has(name))
    if (missing !== undefined) fail(`${entry}-*-keyed_${missing}.json`, `${entry} has no result for ${missing}`)
  }
}

const medianOf = (results: Results, entry: string, benchmark: string): number =>
  results.get(entry)?.get(benchmark)?.median ?? Number.NaN

const smallestMedian = (results: Results, benchmark: string): number =>
  Math.min(...[...results.keys()].map((entry) => medianOf(results, entry, benchmark)))

/** Geometric mean of `factors` weighted by the weight of each benchmark. */
const weightedGeomean = (factors: ReadonlyArray<number>, benchmarks: ReadonlyArray<Benchmark>): number => {
  const logSum = benchmarks.reduce((sum, { weight }, index) => sum + weight * Math.log(factors[index] ?? Number.NaN), 0)
  return Math.exp(logSum / benchmarks.reduce((sum, { weight }) => sum + weight, 0))
}

const rowOf = (results: Results, group: Group, smallest: ReadonlyArray<number>, entry: string): Omit<Row, "rank"> => {
  const medians = group.benchmarks.map((benchmark) => medianOf(results, entry, benchmark.name))
  const factors = medians.map((median, index) => median / (smallest[index] ?? Number.NaN))
  return { entry, medians, factors, geomean: weightedGeomean(factors, group.benchmarks) }
}

const rankedRows = (results: Results, group: Group): ReadonlyArray<Row> => {
  const smallest = group.benchmarks.map((benchmark) => smallestMedian(results, benchmark.name))
  const rows = [...results.keys()].map((entry) => rowOf(results, group, smallest, entry))
  return rows.sort((a, b) => a.geomean - b.geomean).map((row, index) => ({ ...row, rank: index + 1 }))
}

const markdownTable = (header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string =>
  [header, header.map(() => "---"), ...rows].map((cells) => `| ${cells.join(" | ")} |`).join("\n")

const cellsOf = (group: Group, row: Row): ReadonlyArray<string> => {
  const numbers = group.cells === "factor" ? row.factors : row.medians
  return numbers.map((number) => number.toFixed(group.digits))
}

const groupTable = (group: Group, rows: ReadonlyArray<Row>): string => {
  const geomeanHeader = group.type === "cpu" ? "weighted geomean" : "geomean"
  const header = ["Entry", ...group.benchmarks.map((benchmark) => benchmark.header), geomeanHeader, "rank"]
  const body = rows.map((row) => [row.entry, ...cellsOf(group, row), row.geomean.toFixed(3), String(row.rank)])
  return `### ${group.title}\n\n${markdownTable(header, body)}`
}

const sampleCounts = (results: Results, benchmark: string): string => {
  const perCount = new Map<number, number>()
  for (const samples of results.values()) {
    const count = samples.get(benchmark)?.count ?? 0
    perCount.set(count, (perCount.get(count) ?? 0) + 1)
  }
  const parts = [...perCount].map(([count, entries]) => `${count} (${entries} entries)`)
  return `${benchmark}: ${parts.join(", ")}`
}

const summary = (results: Results): string => {
  const benchmarks = GROUPS.flatMap((group) => group.benchmarks.map((benchmark) => benchmark.name))
  const lines = benchmarks.map((benchmark) => `- ${sampleCounts(results, benchmark)}`)
  return `${results.size} entries. Samples per benchmark:\n\n${lines.join("\n")}`
}

/** Ratio of the run-clear memory of `entry` to the baseline entry's, or `–` when the set has no baseline. */
const memoryRatio = (results: Results, entry: string): string => {
  const baseline = medianOf(results, BASELINE, RUN_CLEAR_MEMORY)
  if (Number.isNaN(baseline)) return "–"
  return `${(medianOf(results, entry, RUN_CLEAR_MEMORY) / baseline).toFixed(2)}×`
}

const compactTable = (results: Results, cpuRows: ReadonlyArray<Row>): string => {
  const header = ["Entry", "CPU weighted geomean", "CPU rank", "run-clear MiB", `vs ${BASELINE}`, "brotli KiB", "first paint ms"]
  const body = cpuRows.map((row) => [
    row.entry,
    row.geomean.toFixed(3),
    String(row.rank),
    medianOf(results, row.entry, RUN_CLEAR_MEMORY).toFixed(3),
    memoryRatio(results, row.entry),
    medianOf(results, row.entry, BROTLI).toFixed(1),
    medianOf(results, row.entry, FIRST_PAINT).toFixed(1)
  ])
  return `### Comparison\n\n${markdownTable(header, body)}`
}

const report = (results: Results): string => {
  const cpuRows = rankedRows(results, CPU)
  return [
    summary(results),
    groupTable(CPU, cpuRows),
    groupTable(MEMORY, rankedRows(results, MEMORY)),
    groupTable(SIZE, rankedRows(results, SIZE)),
    compactTable(results, cpuRows)
  ].join("\n\n")
}

/** pnpm runs a script in the package directory; `INIT_CWD` is the directory the user typed the command in. */
const invocationDirectory = (): string => process.env.INIT_CWD ?? process.cwd()

const main = (argv: ReadonlyArray<string>): void => {
  const dir = argv[2]
  if (dir === undefined) throw new ResultsError("usage: jfb:table <directory of js-framework-benchmark result files>")
  const results = loadResults(resolve(invocationDirectory(), dir))
  requireComplete(results)
  console.log(report(results))
}

try {
  main(process.argv)
} catch (error) {
  if (!(error instanceof ResultsError)) throw error
  console.error(error.message)
  process.exitCode = 1
}
