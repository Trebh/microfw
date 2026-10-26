import type { StepKind } from "@mufw/core"

export type Source = "deck" | "stage"

/** One record some loop wrote: which loop, and what kind of record. */
export interface Seen {
  readonly source: Source
  readonly kind: StepKind
}

/** What the evening has recorded so far. */
export interface Tally {
  /** Steps the deck took: every cue, every click on the controls. */
  readonly deck: number
  /** Steps the box office took. */
  readonly stage: number
  /** Travels of either loop: a rewind is a record too. */
  readonly rewinds: number
}

export const emptyTally: Tally = { deck: 0, stage: 0, rewinds: 0 }

/** The opening record of a history and a restore from an event log's snapshot are no step; a travel is counted apart from the steps. */
export const tally = (current: Tally, seen: Seen): Tally => {
  if (seen.kind === "init" || seen.kind === "restore") return current
  if (seen.kind === "travel") return { ...current, rewinds: current.rewinds + 1 }
  return seen.source === "deck" ? { ...current, deck: current.deck + 1 } : { ...current, stage: current.stage + 1 }
}
