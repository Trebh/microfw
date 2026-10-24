export interface Row {
  readonly id: number
  readonly label: string
}

export const CREATE_COUNT = 1000
export const CREATE_LOTS_COUNT = 10000

const UPDATE_STEP = 10
const UPDATE_SUFFIX = " !!!"
const SWAP_FIRST = 1
const SWAP_SECOND = 998

/** Rows for `labels`, numbered from `nextId`: the ids are the caller's counter, not randomness. */
export const withLabels = (nextId: number, labels: ReadonlyArray<string>): ReadonlyArray<Row> =>
  labels.map((label, offset) => ({ id: nextId + offset, label }))

/** Every 10th row, from the first, gets ` !!!` appended to its label. */
export const updateEveryTenth = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
  rows.map((row, index) => (index % UPDATE_STEP === 0 ? { id: row.id, label: row.label + UPDATE_SUFFIX } : row))

/** Rows 1 and 998 trade places; a shorter table is left as it is. */
export const swapRows = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> => {
  const first = rows[SWAP_FIRST]
  const second = rows[SWAP_SECOND]
  if (first === undefined || second === undefined) return rows
  return rows.map((row, index) => (index === SWAP_FIRST ? second : index === SWAP_SECOND ? first : row))
}
