import type { Bound, Tag } from "uhtml/keyed"
import type { KeyedRows } from "./Table.view.ts"

/**
 * The control's keyed list: the same mechanism as `makeKeyedList` of `@mufw/view-uhtml`, written out
 * here so the plain entry stays free of `@mufw/*`. The memo holds the keys of the latest render only;
 * a new key takes its bound tag from a throwaway ref, so uhtml's own table does not keep the row.
 */
export const makePlainKeyedRows = (bound: Bound): KeyedRows => {
  let memo = new Map<string | number, Tag>()
  return (items, keyOf, build) => {
    const next = new Map<string | number, Tag>()
    const nodes = items.map((item) => {
      const key = keyOf(item)
      const tag = next.get(key) ?? memo.get(key) ?? bound({}, key)
      next.set(key, tag)
      return build(tag, item)
    })
    memo = next
    return nodes
  }
}
