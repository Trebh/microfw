const adjectives = [
  "pretty",
  "large",
  "big",
  "small",
  "tall",
  "short",
  "long",
  "handsome",
  "plain",
  "quaint",
  "clean",
  "elegant",
  "easy",
  "angry",
  "crazy",
  "helpful",
  "mushy",
  "odd",
  "unsightly",
  "adorable",
  "important",
  "inexpensive",
  "cheap",
  "expensive",
  "fancy"
]
const colours = ["red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black", "orange"]
const nouns = [
  "table",
  "chair",
  "house",
  "bbq",
  "desk",
  "car",
  "pony",
  "cookie",
  "sandwich",
  "burger",
  "pizza",
  "mouse",
  "keyboard"
]

/** A source of numbers in [0, 1), `Math.random` or an Effect `Random` service. */
export type Uniform = () => number

/** The benchmark's own `_random`: `Math.round(Math.random() * 1000) % max`. */
const randomIndex = (uniform: Uniform, max: number) => Math.round(uniform() * 1000) % max

const pick = (words: ReadonlyArray<string>, uniform: Uniform) => words[randomIndex(uniform, words.length)]!

const makeLabel = (uniform: Uniform) => `${pick(adjectives, uniform)} ${pick(colours, uniform)} ${pick(nouns, uniform)}`

/** `count` row labels drawn from the benchmark's word lists. */
export const makeLabels = (count: number, uniform: Uniform): ReadonlyArray<string> =>
  Array.from({ length: count }, () => makeLabel(uniform))
