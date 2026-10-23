import { Effect } from "effect"

const unitMillis: Readonly<Record<string, number>> = { ms: 1, s: 1000 }

/** A CSS time (`450ms`, `0.2s`) in milliseconds; anything else is 0. */
export const parseCssMillis = (value: string): number => {
  const match = /^\s*(-?[\d.]+)(ms|s)\s*$/.exec(value)
  if (match === null) return 0
  return Number(match[1]) * (unitMillis[match[2] ?? "ms"] ?? 1)
}

/**
 * The duration a stylesheet gives a custom property, read from the root element: the sleeps that
 * wait on a CSS transition take the transition's own length, including its reduced-motion value.
 */
export const cssMillis = (property: string): Effect.Effect<number> =>
  Effect.sync(() => parseCssMillis(getComputedStyle(document.documentElement).getPropertyValue(property)))
