# Benchmark positioning

Source of truth: `examples/jfb/` (the two benchmark entries and their README), the
[js-framework-benchmark](https://github.com/krausest/js-framework-benchmark) (JFB) checkout the entries run in,
and the published Chrome 154 results page it is compared with. The local figures are one run on one machine;
the page that records what µFW costs in its own benches is [Performance](../architecture/performance.md).

## Stance

Performance is not what µFW is for: the reasons to use it are placement flexibility (one definition, several
placements), a schema at every boundary, and every step recorded. This page places µFW on the benchmarks the
field uses, so the tradeoff is visible and not argued. Every figure sits next to a baseline run in the same
session. The entry was not tuned to win, and a result that reads badly stays in. "Derived" marks arithmetic on
printed figures; `[inference]` marks a statement no source or run states.

## The standard benchmarks

| Benchmark | What it measures | Portable | Applies to µFW | Reason |
|---|---|---|---|---|
| [js-framework-benchmark](https://krausest.github.io/js-framework-benchmark/) | In the browser: 9 CPU table operations, click to paint; 3 memory samples; uncompressed and brotli size; first paint | Ratios within one release, roughly; absolute ms no | Direct | µFW renders a 1000-row table; an entry can be built. The official table needs a published package, so a µFW run is local [inference] |
| [Speedometer 3.1](https://browserbench.org/Speedometer3.1/about.html) | Browser responsiveness on TodoMVC variants and other workloads | No: per browser and device | No | Its about page: "should not be used as a way to compare the performance of different JavaScript frameworks" |
| [HTTP Archive Core Web Vitals Technology Report](https://httparchive.org/reports/techreport/tech) (CrUX field data) | Share of origins with good LCP, INP and CLS, per detected technology | Field data, not a lab measure | No | µFW has no production origins and no detection fingerprint, so it has no row [inference from the detection method] |
| [Web Almanac, JavaScript chapter](https://almanac.httparchive.org/en/2024/javascript) | Web-wide JS bytes, requests, library detection | Web-wide statistics | Context only | Gives the median page's JS weight to read µFW's bundle against; the 2025 edition has [no JavaScript chapter](https://almanac.httparchive.org/en/2025/table-of-contents) |
| Bundle-size tools ([bundlejs](https://github.com/okikio/bundlejs), [bundlephobia](https://github.com/pastelsky/bundlephobia), [size-limit](https://github.com/ai/size-limit)) | Minified plus gzip or brotli bytes of an import | Deterministic per bundler and version | Direct | Already reported by `bench:bundle`; JFB's size columns use brotli |
| [TechEmpower Framework Benchmarks](https://www.techempower.com/benchmarks/) | Server HTTP throughput: JSON, queries, Fortunes, updates, plaintext, cache | No: fixed lab hardware | No | The test types are HTTP request and response against a database; µFW's server is a websocket RPC state loop. The project was [sunset](https://github.com/TechEmpower/FrameworkBenchmarks/issues/10932) after Round 23 |
| [js-reactivity-benchmark](https://github.com/milomg/js-reactivity-benchmark) | Propagation cost in a signals graph | Per machine | No | µFW has no reactive graph; its loop is queue, decode, history append [inference] |
| Redux, XState, actor and event-sourcing throughput | none | none | No standard exists | No benchmark directory in `reduxjs/redux`, `reduxjs/redux-toolkit` or `statelyai/xstate` (observed); `bench:loop` against a plain reducer is the only honest measure |
| [Lighthouse](https://developer.chrome.com/docs/lighthouse/performance/performance-scoring) and INP lab proxies | Weighted lab score of one page: FCP, Speed Index, LCP, TBT, CLS | Varies with device and network | Partial | It scores a page, not a framework; `bench:browser` reports script time and main-thread task time, the closest metrics |

Each row links the owner's page. JFB is the only row that gives µFW a framework-versus-framework measurement;
the other rows say why nothing is claimed, and `bench:bundle`, `bench:browser`, `bench:loop` and
`bench:server` in [Performance](../architecture/performance.md) cover what remains.

## js-framework-benchmark methodology

What a reader needs to interpret the numbers, from JFB's
[README](https://github.com/krausest/js-framework-benchmark) and its driver sources under `webdriver-ts/src/`.

**Benchmarks.** Nine CPU operations on a table of 1000 rows unless said: create 1,000 rows, replace all rows,
update every 10th row, select a row, swap rows 2 and 999, remove a row, create 10,000 rows, append 1,000 rows
to 1,000, clear. Three memory samples: after load, after adding 1,000 rows, after creating and clearing 1,000
rows five times. Three size figures: uncompressed KB, brotli KB and first paint in ms.

**How a sample is taken.** Each CPU iteration opens a new tab, runs the warm-up (5 passes, 3 for partial update),
applies CPU throttling, starts a Chrome trace, forces a garbage collection, performs one operation and stops the
trace. The duration runs from the click event to the first compositor commit after the last frame, timer or layout
work ([how it is measured](https://github.com/krausest/js-framework-benchmark/wiki/How-the-duration-is-measured)).
Each run stores `total`, `script` and `paint`; the site's default is `total`. `bench:browser` measures
something else: click to `requestAnimationFrame` then `setTimeout(0)`, without the trace's layout and paint
(observed in both sources).

**Runs and throttling.**

| Benchmark | Throttle | Runs |
|---|---|---|
| create 1,000, replace, create 10,000, append | none | 15 |
| partial update, swap, clear | 4× | 15 |
| select | 4× | 25 |
| remove | 2× | 15 |
| memory, size, first paint | none | 1 |

Throttling is Chrome's CPU throttling rate, applied after the warm-up and reset afterwards. The memory
benchmarks run once, so a memory figure has no spread. Memory is `performance.measureUserAgentSpecificMemory()`
after a forced collection; the runner stores MiB, and the memory figures on this page are MiB.

**Factor against the fastest, weights.** Per benchmark the statistic is the median of the runs. An entry's
factor is its median divided by the smallest median of any entry of the same type in that benchmark, not
divided by vanilla JavaScript: keyed entries are compared only with keyed ones. The CPU headline, and the
default sort, is the weighted geometric mean of the nine factors, `exp(Σ wᵢ·ln fᵢ / Σ wᵢ)`, with these weights
([wiki](https://github.com/krausest/js-framework-benchmark/wiki/Computation-of-the-weighted-geometric-mean)):

| create 1k | replace | partial update | select | swap | remove | create 10k | append | clear |
|---|---|---|---|---|---|---|---|---|
| 0.6428 | 0.5607 | 0.5644 | 0.1926 | 0.1320 | 0.5277 | 0.5644 | 0.5508 | 0.4226 |

A weight is 1 over the 90th-percentile factor across implementations (as of Chrome 118), so select and swap,
whose factors spread widely, count least. Each cell carries a 95% confidence interval, `1.96·sd/√n`, for CPU
only. A factor of 1.00 means "as fast as the fastest implementation of that benchmark", and when another entry
is faster than vanilla JavaScript on a row, that row's baseline silently becomes that entry.

**Memory and size aggregates.** Each is an unweighted geometric mean of three factors. The size aggregate mixes
uncompressed KB, brotli KB and first paint in ms, so it is not a size ratio.

**Notes.** An entry may carry notes that qualify its result; the ones that matter here are
[#772](https://github.com/krausest/js-framework-benchmark/issues/772) (manual DOM manipulation in end-user
code), [#796](https://github.com/krausest/js-framework-benchmark/issues/796) (explicit
`requestAnimationFrame`), [#800](https://github.com/krausest/js-framework-benchmark/issues/800) (selection flag
per row, view state on the model) and [#801](https://github.com/krausest/js-framework-benchmark/issues/801)
(explicit event delegation). The page includes entries with notes by default.

**Keyed.** A keyed entry keeps one DOM node per data item, found by a stable key; a non-keyed one may reuse a
node for other data and "can be more performant". `npm run isKeyed` checks the classification, and the site's
tables are separate. The comparison here is keyed only.

**Limits of this checkout.** The README still lists Lighthouse startup metrics, but the harness leaves them out of
the runnable set: `--benchmark 30_` runs nothing, so there is no startup or time-to-interactive figure, only
first paint. The results page hard-codes its browser label as "Chrome 154.0.8037.98", whatever browser ran, and
the result files record no browser version; this page states the version the local run used. JFB's own advice is
to compare within one release.

## The µFW entry and its control

Two entries render the same markup, both keyed through `htmlFor` from `uhtml/keyed` (uhtml 4.7.1), both under
`examples/jfb/` ([README](../../examples/jfb/README.md)).

| Entry | What it is |
|---|---|
| `mufw` | An idiomatic µFW definition: a `SamDefinition` mounted with `layerMount` over `layerLoopLocal`, `layerInputScheduler` provided last |
| `uhtml4` | The control: plain uhtml 4, one state variable, one `render` per click, no µFW |

**Why the control exists.** JFB has no entry for µFW's architecture, so the published table cannot place it, and
the published uhtml entry is uhtml 5.0.3 with note #772, not the same renderer, version or markup path. `uhtml4`
uses the same template, the same keyed rendering and the same pure row operations as `mufw`; the difference
between the two is what µFW itself adds, not the renderer's cost.

**What is on.** Nothing is turned off to help the figure.

- History: every step is recorded, `HistoryLimit` and `HistoryRetainedSize` at their defaults; a step that copies
  the rows array records a value that shares its elements with the previous one.
- Schemas: model, intents, proposals and representation are declared as `Schema`s. A local loop crosses no
  boundary, so it decodes nothing per click; a remote placement would decode at each hop. The entry therefore
  does not measure schema decoding.
- Actions draw the labels from Effect's `Random` service and the acceptors stay pure; selection is one `selected`
  id in the model, recorded in the history.

**Keyed rendering and its retention.** A row is ``htmlFor(rowsKey, row.id)`<tr>…</tr>` ``, which returns the same
`<tr>` for the same id on every render. `htmlFor` memoizes per `(ref, key)` and uhtml 4 has no API to drop a key,
so the `<tr>` of a removed or replaced row stays referenced for as long as `rowsKey` does. The memory
benchmarks that create rows repeatedly show it; in headless Chromium the JS heap after five create and clear
cycles of 1,000 rows was about twice the heap after one, for both entries (measured, README). The retention is in
the control too, so it does not separate them, but it inflates both against entries that release nodes.

**JFB flags.** None is declared in `package.json`. #772: no, the view is a template. #796: no; the input
scheduler uses microtasks and `setTimeout`. #800: no; one `selected` id in the model. #801: no; uhtml assigns
`onclick` to each element and the click becomes an intent. Recording history is on in `mufw` and absent from
`uhtml4`; no JFB note covers it, and it is the cost the control isolates.

**Eligibility for the official table.** `@mufw/core` is `"private": true` at version `0.0.0`, and JFB's review
expects the rendering library on npm and on GitHub, so the entry is a local one [inference from the landscape
survey]. A local run is never "the JFB result": it is quoted as a ratio to `vanillajs` from the same session.

**Reproduce.** The JFB checkout needs its server (`npm start`, port 8080) and
`npm ci --legacy-peer-deps && npm run install-local`; the first flag is needed because plain `npm ci` fails on a
peer-dependency conflict among the lint packages (observed).

```sh
pnpm --filter @mufw/example-jfb build
pnpm --filter @mufw/example-jfb jfb:install <jfb-checkout>
cd <jfb-checkout>
npm run bench -- --framework keyed/vanillajs keyed/uhtml keyed/uhtml4 keyed/mufw
npm run results        # table at http://localhost:8080/webdriver-ts-results/dist/index.html
cd webdriver-ts && npm run isKeyed -- --runner playwright --headless true keyed/mufw
```

Do not run `rebuild-ci`, `rebuild` or `clean` on these directories: they delete `dist/`, which is all an
installed entry holds. `--framework` matches `keyed/<dir>` exactly and `--benchmark` by substring (`01_`).

## Results

One run on this machine, 17 keyed entries, JFB's defaults: 15 CPU samples per benchmark (25 for select), one
sample for memory, size and first paint, the throttling listed above. Browser Google Chrome 156.0.8078.48
(headed, window 1280×800), Apple M5 with 16 GB, macOS 27.0.1, JFB commit `3ab4cea`, Node 24.21.0, puppeteer
runner. The published page was measured on Chrome 154.0.8037.98, an M4 with 48 GB; the results page of the local
run says "Chrome 154" because it hard-codes the label, and that label is wrong for this run. The entries ran one
at a time, in one pass of 1 h 18 min, each in its own invocation with the display kept awake; every invocation
exited 0, every result file has the expected sample count, and no log line reports a failure or a retry. Before
timing, `checkCSP` and a smoke run passed for both µFW entries. The machine was not shown to be idle (load
average 2.78 at the start, cause not identified).

The entries are `vanillajs`, `mufw`, `uhtml4` (the control), `uhtml` (**uhtml 5.0.3**, note #772, JFB's own
entry), `solid`, `svelte`, `vue`, `lit`, `preact-hooks`, `react-hooks`, `react-redux-hooks`, `react-zustand`,
`angular-cf`, `elm`, `hyperapp`, `mobx-jsx` and `re-frame`. Medians of the stored samples, as the site shows
them. Raw runner files are in `docs/spikes/jfb-results/` (this pass), `repeat/` and `repeat-2/`.

Every factor, mean and rank below is derived from those files. A factor is a median over the fastest median **of
these 17 entries**, so a local headline is lower than the published headline of the same implementation (local
over published: 0.914 to 0.982 on the 14 entries in both, derived); a rank is a rank in the 17, not the 196.

### CPU

Factor = median `total` over the fastest median of the set; last columns: weighted geometric mean with JFB's
weights, and rank in the 17.

| Entry | create 1k | replace | update 10th | select | swap | remove | create 10k | append | clear | weighted geomean | rank |
|---|---|---|---|---|---|---|---|---|---|---|---|
| vanillajs | 1.00 | 1.00 | 1.00 | 1.17 | 1.00 | 1.01 | 1.00 | 1.00 | 1.00 | 1.009 | 1 |
| solid | 1.10 | 1.11 | 1.07 | 1.39 | 1.15 | 1.01 | 1.07 | 1.07 | 1.33 | 1.112 | 2 |
| svelte | 1.10 | 1.16 | 1.10 | 2.00 | 1.21 | 1.05 | 1.08 | 1.09 | 1.34 | 1.155 | 3 |
| mobx-jsx | 1.24 | 1.22 | 1.11 | 1.22 | 1.16 | 1.00 | 1.17 | 1.18 | 1.23 | 1.164 | 4 |
| uhtml 5.0.3 (#772) | 1.27 | 1.31 | 1.22 | 1.00 | 1.11 | 1.02 | 1.23 | 1.23 | 1.41 | 1.220 | 5 |
| lit | 1.19 | 1.21 | 1.19 | 2.30 | 1.40 | 1.13 | 1.14 | 1.21 | 1.58 | 1.259 | 6 |
| hyperapp | 1.40 | 1.25 | 1.21 | 2.04 | 1.13 | 1.14 | 1.18 | 1.31 | 1.23 | 1.270 | 7 |
| vue | 1.21 | 1.25 | 1.31 | 1.61 | 1.18 | 1.26 | 1.17 | 1.18 | 1.60 | 1.276 | 8 |
| **uhtml4** (control) | 1.23 | 1.28 | 1.60 | 2.96 | 1.53 | 1.31 | 1.22 | 1.26 | 1.40 | **1.374** | 9 |
| **mufw** | 1.22 | 1.29 | 1.68 | 3.61 | 1.68 | 1.36 | 1.23 | 1.31 | 1.64 | **1.440** | 10 |
| elm | 1.33 | 1.31 | 1.31 | 2.13 | 1.21 | 1.21 | 2.55 | 1.44 | 1.37 | 1.477 | 11 |
| react-hooks | 1.24 | 1.37 | 1.39 | 2.39 | 7.23 | 1.10 | 1.64 | 1.24 | 2.04 | 1.498 | 12 |
| angular-cf | 1.78 | 1.57 | 1.11 | 2.39 | 1.22 | 1.25 | 1.40 | 1.56 | 2.00 | 1.514 | 13 |
| preact-hooks | 1.28 | 1.37 | 2.00 | 5.91 | 1.96 | 1.46 | 1.27 | 1.33 | 1.48 | 1.547 | 14 |
| react-zustand | 1.33 | 1.43 | 1.49 | 2.26 | 7.52 | 1.19 | 1.98 | 1.30 | 2.24 | 1.615 | 15 |
| react-redux-hooks | 1.35 | 1.45 | 1.65 | 2.35 | 7.49 | 1.20 | 1.99 | 1.33 | 2.28 | 1.657 | 16 |
| re-frame | 2.38 | 2.55 | 3.45 | 8.09 | 9.31 | 2.21 | 2.14 | 2.22 | 5.23 | 2.925 | 17 |

`vanillajs` holds the fastest median in every benchmark but two: `uhtml` 5.0.3 holds select (2.3 ms, against
2.7 for vanillajs, so vanillajs's headline is 1.009 and not 1.000), and `mobx-jsx` holds remove (9.6 ms, against
9.7). The fastest medians are 18.1, 19.7, 10.7, 2.3, 11.7, 9.6, 194.0, 21.5 and 8.3 ms in the benchmark order of
the table. The results app printed the same factors (all 153 at two decimals) and the same CPU headlines.

`mufw` and `uhtml4` are in the middle of the set, ninth and tenth of 17, with the largest factors in select
(3.61 and 2.96, a 4×-throttled operation of 6.8 to 8.3 ms) and in partial update, swap and clear. `react-hooks`,
`react-redux-hooks` and `react-zustand` have a swap factor above 7. Select and swap carry the lowest weights
(0.19 and 0.13). These ranks are set 1's; two later passes put `uhtml4` and `mufw` about 9% lower, see
[Run-to-run noise](#run-to-run-noise).

### Memory

One sample per entry, so no interval. MiB, as the runner stores them; the geomean is unweighted over the three
factors against the smallest value of the set (all three held by `vanillajs`).

| Entry | ready | after 1,000 rows | after create and clear ×5 | geomean | rank |
|---|---|---|---|---|---|
| vanillajs | 0.568 | 1.835 | 0.635 | 1.000 | 1 |
| hyperapp | 0.581 | 2.933 | 0.655 | 1.191 | 2 |
| solid | 0.589 | 2.649 | 0.773 | 1.222 | 3 |
| preact-hooks | 0.586 | 3.308 | 0.817 | 1.338 | 4 |
| uhtml 5.0.3 (#772) | 0.699 | 2.642 | 0.895 | 1.357 | 5 |
| lit | 0.714 | 2.803 | 0.880 | 1.386 | 6 |
| svelte | 0.669 | 2.870 | 0.983 | 1.419 | 7 |
| elm | 0.678 | 3.653 | 1.031 | 1.568 | 8 |
| mobx-jsx | 0.858 | 3.863 | 1.157 | 1.796 | 9 |
| vue | 0.862 | 3.866 | 1.153 | 1.798 | 10 |
| react-hooks | 1.182 | 4.426 | 1.982 | 2.503 | 11 |
| **uhtml4** (control) | 0.583 | 2.291 | 8.405 | **2.570** | 12 |
| react-zustand | 1.128 | 6.050 | 2.003 | 2.744 | 13 |
| react-redux-hooks | 1.226 | 5.933 | 2.017 | 2.809 | 14 |
| angular-cf | 1.610 | 4.566 | 2.220 | 2.911 | 15 |
| **mufw** | 1.314 | 3.136 | 9.455 | **3.891** | 16 |
| re-frame | 1.910 | 7.627 | 3.330 | 4.186 | 17 |

The third column is where both µFW entries leave the field: 9.455 and 8.405 MiB, 14.9× and 13.2× `vanillajs`
(derived), and 2.8× and 2.5× the largest of the other 15 entries, `re-frame` at 3.330 (derived). It is the
retention of uhtml 4's `htmlFor`, which keeps the `<tr>` of every removed row for as long as the keyed list's
reference lives (see [The µFW entry and its control](#the-µfw-entry-and-its-control)). The control has no µFW and
shows the same figure, so the retention is the renderer's and not µFW's: `mufw` adds 1.05 MiB over `uhtml4` in
this sample (derived). After 1,000 rows the two sit at 3.136 and 2.291, inside the field (`react-hooks` 4.426,
`vue` 3.866). The results app prints memory factors computed from two-decimal values, so a few of its geomeans
differ from these by up to 0.021.

### Size and first paint

One sample per entry. Uncompressed and brotli sizes are the sum of every file the page requests, in KiB, from
the benchmark server; first paint is the browser's `first-paint` entry in ms. The geomean is unweighted over the
three factors against the smallest value of the set (6.3 KiB `hyperapp`, 2.5 KiB `vanillajs`, 70.3 ms
`preact-hooks`); it mixes bytes and milliseconds.

| Entry | uncompressed KiB | brotli KiB | first paint ms | geomean | rank |
|---|---|---|---|---|---|
| hyperapp | 6.3 | 2.6 | 76.3 | 1.041 | 1 |
| vanillajs | 11.3 | 2.5 | 73.2 | 1.231 | 2 |
| **uhtml4** (control) | 8.7 | 3.9 | 70.4 | **1.292** | 3 |
| solid | 11.5 | 4.5 | 90.5 | 1.617 | 4 |
| preact-hooks | 14.8 | 5.9 | 70.3 | 1.770 | 5 |
| uhtml 5.0.3 (#772) | 17.5 | 6.7 | 82.2 | 2.057 | 6 |
| lit | 22.1 | 7.3 | 76.7 | 2.236 | 7 |
| svelte | 26.6 | 9.7 | 91.7 | 2.775 | 8 |
| elm | 31.7 | 10.4 | 114.2 | 3.240 | 9 |
| mobx-jsx | 56.4 | 15.6 | 99.2 | 4.288 | 10 |
| vue | 64.3 | 23.3 | 138.9 | 5.728 | 11 |
| **mufw** | 135.6 | 40.0 | 222.0 | **10.284** | 12 |
| angular-cf | 144.1 | 44.7 | 196.2 | 10.451 | 13 |
| react-redux-hooks | 185.9 | 50.6 | 251.5 | 12.880 | 14 |
| react-zustand | 182.9 | 49.8 | 273.7 | 13.107 | 15 |
| react-hooks | 190.3 | 51.4 | 279.1 | 13.510 | 16 |
| re-frame | 351.1 | 80.8 | 427.6 | 22.210 | 17 |

The two byte columns are deterministic given the build: they equal the published value for 14 of the 15 anchors
(`angular-cf` 0.98, a build one patch version apart [inference]). First paint is not portable: this run's value
is 1.05 to 1.75 times the published one for every anchor (one sample, another machine and Chrome), so use it only
as a ratio between entries measured here. The size geomean carries that noise.

### What µFW adds over its renderer

`mufw` against `uhtml4`: same markup, same keyed rendering, same row operations. Ratio of medians, this pass.

| | create 1k | replace | update 10th | select | swap | remove | create 10k | append | clear | weighted geomean |
|---|---|---|---|---|---|---|---|---|---|---|
| total ms, `mufw` | 22.0 | 25.5 | 18.0 | 8.3 | 19.6 | 13.1 | 238.6 | 28.1 | 13.6 | |
| total ms, `uhtml4` | 22.2 | 25.2 | 17.1 | 6.8 | 17.9 | 12.6 | 236.0 | 27.1 | 11.6 | |
| total ratio | 0.99 | 1.01 | 1.05 | 1.22 | 1.10 | 1.04 | 1.01 | 1.04 | 1.17 | 1.048 |
| script ms, `mufw` | 4.2 | 6.5 | 4.3 | 3.9 | 4.2 | 2.1 | 35.6 | 5.4 | 11.0 | |
| script ms, `uhtml4` | 3.4 | 5.6 | 3.7 | 3.3 | 3.4 | 1.6 | 34.2 | 4.7 | 9.1 | |
| script ratio | 1.24 | 1.16 | 1.16 | 1.18 | 1.24 | 1.31 | 1.04 | 1.15 | 1.21 | 1.180 |
| paint ms, `mufw` | 17.4 | 18.4 | 11.5 | 2.7 | 13.4 | 10.0 | 195.1 | 21.5 | 1.2 | |
| paint ms, `uhtml4` | 18.3 | 18.8 | 11.2 | 2.7 | 12.0 | 10.1 | 194.3 | 21.5 | 1.0 | |

The total is 1.048× the control's over this pass and 1.040× and 1.051× over the two later ones. The script part
is 1.17× to 1.22× and the paint part equal, so the difference is script: the extra script is 0.5 to 1.9
ms per operation (derived, this pass). A cost fixed per click would be a larger share of a small operation
(select 1.22×, clear 1.17×) and a smaller one of the 10,000-row creation (1.01×) [inference]. The
per-benchmark ratios sit at the size of the run-to-run noise (below); the weighted geomean is the stable figure.

| | after load | after 1,000 rows | after create and clear ×5 | uncompressed KiB | brotli KiB | first paint ms |
|---|---|---|---|---|---|---|
| `mufw` | 1.314 | 3.136 | 9.455 | 135.6 | 40.0 | 222.0 |
| `uhtml4` | 0.583 | 2.291 | 8.405 | 8.7 | 3.9 | 70.4 |
| ratio (derived) | 2.25× | 1.37× | 1.12× | 15.6× | 10.3× | 3.15× |

What µFW adds is mostly bytes, and with the bytes the load: first paint is 3.15× the control's (one sample),
and memory after load 2.25× (one sample). The run-clear ratio, 1.12×, is the retention both entries share. Where
the bytes come from is in [Performance](../architecture/performance.md#bundle): Effect is most of a µFW page, and
µFW's own packages a small part; this run does not re-derive it. The CPU price, on the other hand, is about 5% of
a JFB operation.

### Place in the published ranking

[inference] throughout this section: no µFW entry is in the published table, and the numbers below are an
estimate of where one would fall.

Method. For each benchmark, the local ratio of the entry to `vanillajs` is multiplied by the published
`vanillajs` median of Chrome 154 and divided by the published fastest of 196; the weighted (CPU) or plain
(memory, size) geomean of the nine or three results is the estimated published headline, and the rank is one
plus the number of published entries with a lower headline. Validation. The same procedure applied to each of
the 14 entries present both locally and in the published table (all but `vanillajs` itself) predicts their
published CPU headline to 0.948 to 1.017 times (median 0.989), and their order agrees with the published order
at Spearman 0.982 over 15 (derived). Memory is predicted low by 0.891 to 0.955 times, size 0.918 to 1.088.
Select and swap transfer worst (per-benchmark local-to-published ratio to `vanillajs`: select 0.64 to 0.97, swap
0.51 to 1.02), which is why the weighted headline transfers better than single benchmarks.

| | `mufw` | `uhtml4` (control) |
|---|---|---|
| local CPU headline against `vanillajs`, set 1 / later passes | 1.427 / 1.318, 1.330 | 1.362 / 1.268, 1.265 |
| estimated published CPU headline, set 1 / later passes | 1.493 / 1.379, 1.390 | 1.424 / 1.326, 1.323 |
| estimated CPU rank of 196 (point), set 1 / later passes | 125 / 106, 108 | 119 / 92, 92 |
| CPU rank range from the anchors' error band, all passes | 100 to 133 | 84 to 125 |
| estimated memory rank, point / band | 179 / 182 | 135 / 140 to 146 |
| estimated size rank, point / band | 152 / 150 to 157 | 22 / 15 to 30 |

On CPU the estimate puts `mufw` in the middle of the field: behind `vue` (published headline 1.311) and `hyperapp`
(1.339), ahead of `angular-cf` (1.590), `react-hooks` (1.595) and `elm` (1.616). The published headline of
`uhtml` 5.0.3 is 1.256 (71st); the control, uhtml 4 with `htmlFor`, is estimated at 1.32 to 1.42, 92nd to 119th.
So the renderer choice costs more rank than µFW does: moving from the published uhtml to the control moves 21 to
48 places, and moving from the control to `mufw` moves 6 to 16 (derived from the point estimates; the published
entry is a different version with manual DOM updates, #772, so the two steps are not like for like).

Direct comparison with the published distribution, without scaling (sizes are deterministic; first paint is not
portable), rank of 196 as one plus the published entries with a lower value:

| | `mufw` | rank | `uhtml4` | rank |
|---|---|---|---|---|
| uncompressed KiB | 135.6 | 150 | 8.7 | 16 |
| brotli KiB | 40.0 | 152 | 3.9 | 26 |
| first paint ms (not portable) | 222.0 | 167 | 70.4 | 103 |
| ready memory MiB | 1.314 | 163 | 0.583 | 20 |
| memory after 1,000 rows MiB | 3.136 | 84 | 2.291 | 29 |
| run-clear memory MiB | 9.455 | 190 | 8.405 | 187 |

Published brotli sizes have a median of 11.8 KiB and a 75th percentile of 33.9 (196 keyed); run-clear memory a
median of 1.07, a 75th percentile of 2.05 and a maximum of 61.44 MiB. `mufw`'s 40.0 KiB brotli is under
`react-hooks` (51.4) and `angular-cf` (44.7), over `vue` (23.3) and `svelte` (9.7). On run-clear memory it is 190th
of 196, `uhtml4` 187th.

Limits. The band is the smallest and largest error the method made on the 14 anchors; it is not a confidence
interval. `mufw`'s architecture is unlike every anchor, so nothing says its transfer error lies inside that
band. The difference between this pass and the later ones for `mufw` and `uhtml4` (about 9%) is wider than the
whole band (0.948 to 1.017), and the point estimates move by 17 to 27 places with it.

### Run-to-run noise

Set 1 is the primary pass and nothing was dropped or replaced. Two more passes of the CPU benchmarks were run
afterwards for `vanillajs`, `uhtml4` and `mufw` only, in these orders: pass 2 `vanillajs`, `uhtml4`, `mufw`;
pass 3 `mufw`, `uhtml4`, `vanillajs` (set 1 ran them inside the full set). Medians of `total`, ms:

| | create 1k | replace | update 10th | select | swap | remove | create 10k | append | clear |
|---|---|---|---|---|---|---|---|---|---|
| `vanillajs`, set 1 / pass 2 / pass 3 | 18.1 / 17.9 / 18.0 | 19.7 / 19.4 / 19.5 | 10.7 / 10.4 / 10.1 | 2.7 / 2.5 / 2.6 | 11.7 / 11.6 / 11.8 | 9.7 / 9.5 / 9.5 | 194.0 / 194.0 / 191.2 | 21.5 / 21.5 / 21.2 | 8.3 / 8.0 / 7.6 |
| `uhtml4`, set 1 / pass 2 / pass 3 | 22.2 / 21.1 / 20.9 | 25.2 / 23.3 / 23.3 | 17.1 / 14.4 / 14.1 | 6.8 / 5.5 / 5.4 | 17.9 / 15.7 / 15.3 | 12.6 / 11.2 / 11.0 | 236.0 / 230.0 / 226.9 | 27.1 / 25.7 / 25.6 | 11.6 / 10.7 / 10.6 |
| `mufw`, set 1 / pass 2 / pass 3 | 22.0 / 22.2 / 22.2 | 25.5 / 24.4 / 24.3 | 18.0 / 14.5 / 14.3 | 8.3 / 5.7 / 5.9 | 19.6 / 16.2 / 16.1 | 13.1 / 11.5 / 11.7 | 238.6 / 229.8 / 229.3 | 28.1 / 26.1 / 26.0 | 13.6 / 12.5 / 12.4 |

Weighted geomean of the nine, per pass (derived):

| | set 1 | pass 2 | pass 3 |
|---|---|---|---|
| `mufw` / `uhtml4` | 1.048 | 1.040 | 1.051 |
| `uhtml4` / `vanillajs` | 1.362 | 1.268 | 1.265 |
| `mufw` / `vanillajs` | 1.427 | 1.318 | 1.330 |
| `mufw` script / `uhtml4` script | 1.180 | 1.174 | 1.215 |

In the later passes `uhtml4` and `mufw` are each about 9% faster than in set 1 (weighted geomean of the nine
ratios 0.914 and 0.904 for `uhtml4`, 0.907 and 0.907 for `mufw`), by 11% to 31% on update 10th, select, swap and
remove (select: −19% to −21% for `uhtml4`, −29% to −31% for `mufw`). The two later passes agree with each other to within 3.5% per
benchmark. `vanillajs`, measured in the same passes, moved 0.97 to 0.99, and the order of the passes does not
explain it (`mufw` ran second in set 1, last in pass 2 and first in pass 3). The cause was not found; something
on the machine during the minutes `mufw` and `uhtml4` ran in set 1 is a reading no run checked [inference]. Within
one pass the standard deviation of a benchmark's samples is 1% to 13% of the median, and 9% to 21% for select.

What it changes. With the later passes' medians in place of set 1's, in the set of 17 (the other entries
unchanged) `uhtml4` is 1.24 to 1.26 and sixth, `mufw` 1.31 and tenth. The ratio of `mufw` to `uhtml4` does not
move: 1.040 to 1.051 over the three passes. So the comparison with the control holds, and absolute values and
ranks against the other 14 entries carry the 9% of set 1.

## Positioning

A reading of the figures above, with the limits next to it. [inference] marks what no run measured.

µFW's own runtime adds about 4% to 5% of CPU time over the same renderer on JFB's operations (1.040× to 1.051× over
three passes), with the same paint time and 0.5 to 1.9 ms of extra script per operation. Its place on CPU is the
middle of the field, about 100th to 133rd of 196 keyed [inference], and it is set mostly by uhtml 4 with
`htmlFor`, which alone puts the control at about 84th to 125th [inference]. Where it pays is bytes (10.3× its
renderer in brotli, 40.0 KiB, about 152nd of 196 but under React and Angular), load (first paint 3.15× the
control's, memory after load 2.25×) and memory under row churn, where the retention of uhtml 4's `htmlFor`
puts both µFW entries near the bottom of 196.

| Claim we can make | Claim we must not make |
|---|---|
| µFW costs about 4% to 5% of CPU over its renderer on JFB's nine operations, measured on one machine in three passes | "µFW is X-th in js-framework-benchmark": no µFW entry is in the published table, and a local rank is a rank in 17 |
| A µFW page is about 10× the bytes of the same page in plain uhtml 4 (40.0 against 3.9 KiB brotli) and smaller than a React or Angular entry | "µFW is as fast as uhtml" or "as fast as vanilla JavaScript": it is 1.43× `vanillajs` in set 1 and 1.32× to 1.33× in the later passes, against 1.36× and 1.27× for the control |
| A µFW view with a keyed list keeps every removed row today: run-clear memory is 190th of 196, from uhtml 4's `htmlFor`, which the control shares ([TODO](../TODO.md#view)) | That the retention comes from µFW's loop or history: the control has neither and shows 8.41 of µFW's 9.46 MiB |
| Estimated place on CPU is the middle of the field, by a method that predicted the 14 anchors to 0.948 to 1.017 times | The estimate as a measurement: the band is not a confidence interval and µFW's architecture is unlike every anchor |
| JFB shows the cost of a local loop with history on | What a remote placement costs: JFB does not exercise it |

What this does not measure. Startup: JFB's Lighthouse benchmarks are not runnable in the checkout, so first
paint, one sample, is the only load figure. Remote placements and schema decoding: the entry runs a local loop,
which decodes nothing per click. Other machines, other Chrome versions and other renderers: one M5, Chrome 156.
Memory, size and first paint are one sample each. The 9% difference between set 1 and the later passes for the two
µFW entries is unexplained. For the costs JFB does not see (the bundle by floors, cold start under throttling,
the loop in Node, the server) read [Performance](../architecture/performance.md).
