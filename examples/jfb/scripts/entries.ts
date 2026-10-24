import { Schema } from "effect"
import { fileURLToPath } from "node:url"

export const JFB_ROOT = fileURLToPath(new URL("..", import.meta.url))

/** Where the build leaves one directory per entry, shaped like `frameworks/keyed/<name>` of js-framework-benchmark. */
export const OUT_KEYED = fileURLToPath(new URL("../out/keyed/", import.meta.url))

export interface Entry {
  readonly name: string
  readonly source: string
  readonly title: string
  readonly homeURL: string
  readonly versionOf: "mufw" | "uhtml"
}

export const ENTRIES: ReadonlyArray<Entry> = [
  { name: "mufw", source: "src/mufw.ts", title: "µFW-\"keyed\"", homeURL: "", versionOf: "mufw" },
  {
    name: "uhtml4",
    source: "src/uhtml4.ts",
    title: "uhtml4-\"keyed\"",
    homeURL: "https://github.com/WebReflection/uhtml/tree/v4",
    versionOf: "uhtml"
  }
]

export class JfbFailure extends Schema.TaggedError<JfbFailure>()("JfbFailure", { message: Schema.String }) {}
