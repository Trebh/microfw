export type Side = "client" | "server"

export interface Placement {
  readonly model: Side
  readonly actions: Side
}

const DEFAULT_SIDE: Side = "client"
const DEFAULT_BIDDER = "alice"

const parseSide = (part: keyof Placement, value: string | undefined): Side => {
  if (value === undefined) return DEFAULT_SIDE
  if (value === "client" || value === "server") return value
  console.warn(`mufw: invalid placement ${part}:${value}, using ${DEFAULT_SIDE}`)
  return DEFAULT_SIDE
}

/** Demo page only: parses `?placement=model:server,actions:client`; missing or invalid parts fall back to `client`. */
export const parsePlacement = (search: string): Placement => {
  const parts = new Map(
    (new URLSearchParams(search).get("placement") ?? "").split(",").filter(Boolean).map((part) => {
      const [name = "", value = ""] = part.split(":")
      return [name, value] as const
    })
  )
  return { model: parseSide("model", parts.get("model")), actions: parseSide("actions", parts.get("actions")) }
}

/** `?bidder=bob`; stands in for an authenticated identity. */
export const parseBidder = (search: string) => new URLSearchParams(search).get("bidder") || DEFAULT_BIDDER

export const formatPlacement = (placement: Placement) => `model:${placement.model},actions:${placement.actions}`
