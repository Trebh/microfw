const WORD = 8
const OBJECT_HEADER = 16

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null

const arrayFootprint = (next: ReadonlyArray<unknown>, previous: unknown) => {
  const before: ReadonlyArray<unknown> = Array.isArray(previous) ? previous : []
  let total = OBJECT_HEADER + WORD * next.length
  for (let index = 0; index < next.length; index++) {
    const item = next[index]
    if (item !== before[index]) total += footprint(item, before[index])
  }
  return total
}

const recordFootprint = (next: object, previous: unknown) => {
  const before = (isObject(previous) ? previous : {}) as Readonly<Record<string, unknown>>
  const after = next as Readonly<Record<string, unknown>>
  let total = OBJECT_HEADER
  for (const key of Object.keys(after)) {
    total += WORD
    if (after[key] !== before[key]) total += footprint(after[key], before[key])
  }
  return total
}

/**
 * An estimate, in bytes, of what `next` keeps alive that `previous` does not already keep alive:
 * the cost of retaining `next` next to `previous`. A node that is `===` to the node at the same
 * path of `previous` costs nothing and is not walked, so an unchanged model costs 0 and a copy of
 * an N-element array whose elements are the same objects costs about `8 * N`.
 *
 * Arrays and objects cost a 16-byte header plus 8 bytes per slot or key; a string that differs
 * from the previous one costs its length; a number, boolean or `null` costs its slot, counted by
 * its container; a `Map` or `Set` costs 16 bytes per entry and is not walked. The values are
 * approximate: a model is walked as a tree, so it must have no cycles, and a node shared between
 * two paths of the changed part is counted once per path.
 *
 * The walk visits the slots of every array the step copied and the nodes it replaced, never the
 * parts it left alone.
 */
export const footprint = (next: unknown, previous: unknown): number => {
  if (next === previous) return 0
  if (typeof next === "string") return next.length
  if (!isObject(next)) return 0
  if (Array.isArray(next)) return arrayFootprint(next, previous)
  if (next instanceof Map || next instanceof Set) return OBJECT_HEADER + 2 * WORD * next.size
  return recordFootprint(next, previous)
}
