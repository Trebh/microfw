export type Side = "client" | "server"

export interface Placement {
  readonly model: Side
  readonly actions: Side
  readonly bidder: string
}

const DEFAULTS: Placement = { model: "client", actions: "client", bidder: "alice" }

const parseSide = (part: "model" | "actions", value: string | undefined): Side => {
  if (value === undefined) return DEFAULTS[part]
  if (value === "client" || value === "server") return value
  console.warn(`mufw: invalid placement ${part}:${value}, using ${DEFAULTS[part]}`)
  return DEFAULTS[part]
}

/** Parses `?placement=model:server,actions:client&bidder=bob`; missing or invalid parts fall back to `client`/`alice`. */
export const parsePlacement = (search: string): Placement => {
  const params = new URLSearchParams(search)
  const parts = new Map(
    (params.get("placement") ?? "").split(",").filter(Boolean).map((part) => {
      const [name = "", value = ""] = part.split(":")
      return [name, value] as const
    })
  )
  return {
    model: parseSide("model", parts.get("model")),
    actions: parseSide("actions", parts.get("actions")),
    bidder: params.get("bidder") || DEFAULTS.bidder
  }
}

export const formatPlacement = (placement: Placement) =>
  `model:${placement.model},actions:${placement.actions} · bidder ${placement.bidder}`
