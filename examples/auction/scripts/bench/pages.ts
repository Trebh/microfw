export type BenchPage = "counter-uhtml" | "counter-mufw" | "list-uhtml" | "list-mufw"

/**
 * The pages the benchmarks measure, as html paths relative to `examples/auction/`. A `-uhtml` page
 * is the plain baseline (uhtml and a state variable, no `effect`); the `-mufw` page beside it
 * renders the same markup and behaves the same, over a µFW local loop.
 */
export const benchPages: Readonly<Record<BenchPage, string>> = {
  "counter-uhtml": "scripts/bench/pages/counter-uhtml.html",
  "counter-mufw": "scripts/bench/pages/counter-mufw.html",
  "list-uhtml": "scripts/bench/pages/list-uhtml.html",
  "list-mufw": "scripts/bench/pages/list-mufw.html"
}
