import type { Bound, Tag, Target } from "uhtml/keyed"

/**
 * Renders `items` as one node each, in order. `build` receives the tag bound to the item's key, and
 * the node it returns is the same for the same key on every render. Keys must be unique within one
 * render: a repeated key renders one node, with the last item's values, as `htmlFor` does with a fixed ref.
 */
export type KeyedList = <T>(
  items: ReadonlyArray<T>,
  keyOf: (item: T) => string | number,
  build: (tag: Tag, item: T) => Target
) => ReadonlyArray<Target>

/**
 * A keyed list whose memo holds the keys of its latest render only. `htmlFor(ref, key)` keeps a bound
 * tag, and with it the item's node, for as long as `ref` lives and has no way to drop a key; here each
 * new key gets a bound tag from a throwaway `ref`, so uhtml's own table is collectable and the helper
 * is the only holder. The next render builds a fresh map from the items it was given, which releases
 * the node of every key that is gone.
 *
 * `bound` is uhtml's `htmlFor` (or `svgFor`), passed in because uhtml's entry needs a DOM at import
 * time and this module must load without one. Each list in a view takes its own instance: the memo is
 * the list's state, and two lists sharing one would drop each other's keys.
 */
export const makeKeyedList = (bound: Bound): KeyedList => {
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
