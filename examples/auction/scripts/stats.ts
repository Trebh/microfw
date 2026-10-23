/** Nearest-rank percentile of samples sorted ascending; `NaN` when there are none. */
export const percentile = (sorted: ReadonlyArray<number>, fraction: number) => {
  const rank = Math.ceil(fraction * sorted.length)
  return sorted[Math.max(0, rank - 1)] ?? Number.NaN
}

export interface Summary {
  readonly count: number
  readonly mean: number
  readonly median: number
  readonly p95: number
  readonly p99: number
  readonly max: number
}

export const summarize = (samples: ReadonlyArray<number>): Summary => {
  const sorted = [...samples].sort((a, b) => a - b)
  const total = sorted.reduce((sum, sample) => sum + sample, 0)
  return {
    count: sorted.length,
    mean: sorted.length === 0 ? Number.NaN : total / sorted.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? Number.NaN
  }
}

export const ms = (value: number) => value.toFixed(1)
export const kib = (bytes: number) => (bytes / 1024).toFixed(1)
export const mib = (bytes: number) => (bytes / 2 ** 20).toFixed(1)

/** Rows padded to aligned columns, the first row being the header. */
export const table = (rows: ReadonlyArray<ReadonlyArray<string>>) => {
  const columnCount = Math.max(0, ...rows.map((row) => row.length))
  const widths = Array.from({ length: columnCount }, (_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0)))
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd()).join("\n")
}
