import type { AnyDefinition } from "@mufw/core"
import { Effect, Schema } from "effect"
import { Auction, Model } from "./domain/Auction.ts"

/** The model as JSON text; `toCodecJson` writes an `Option` as plain JSON, which `JSON.stringify` of the model would not. */
const ModelJson = Schema.fromJsonString(Schema.toCodecJson(Model))

/** The `id` of the `<script type="application/json">` that carries the model of `def` in a server-rendered page. */
export const snapshotId = (def: AnyDefinition) => `mufw:${def.name}`

export const AUCTION_SNAPSHOT_ID = snapshotId(Auction)

/**
 * The model as the text of a `<script>` element. `<` is written `\u003c`, which JSON reads back
 * as `<`, so a string in the model cannot close the element or open a comment inside it.
 */
export const encodeSnapshot = (model: Model): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(ModelJson)(model).pipe(Effect.map((json) => json.replaceAll("<", "\\u003c")))

/** Parses the text of that element into the model; text that is not a valid model is a `SchemaError`. */
export const decodeSnapshot = (text: unknown): Effect.Effect<Model, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(ModelJson)(text)
