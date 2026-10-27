// Renders docs/one-page.html to docs/one-page.png, the image README.md shows, in headless Chromium.
// Run by build.py. It fails, writing nothing, unless each Plex family has a face in use and none
// failed to load: a fallback font changes the widths the layout was set for.
import { chromium } from "playwright"
import { fileURLToPath, pathToFileURL } from "node:url"

const html = fileURLToPath(new URL("../one-page.html", import.meta.url))
const png = fileURLToPath(new URL("../one-page.png", import.meta.url))

const families = ["IBM Plex Sans", "IBM Plex Serif", "IBM Plex Mono"]

const fontProblems = (page) =>
  page.evaluate(async (expected) => {
    await document.fonts.ready
    const faces = [...document.fonts]
    const nameOf = (face) => face.family.replaceAll('"', "")
    const failed = faces.filter((face) => face.status === "error").map((face) => `${nameOf(face)} ${face.weight} ${face.style}`)
    const isInUse = (family) => faces.some((face) => nameOf(face) === family && face.status === "loaded")
    const unused = expected.filter((family) => !isInUse(family))
    return [...failed.map((face) => `failed to load: ${face}`), ...unused.map((family) => `never used: ${family}`)]
  }, families)

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 2400, height: 1700 } })
  await page.emulateMedia({ media: "print" })
  await page.goto(pathToFileURL(html).href)
  const problems = await fontProblems(page)
  if (problems.length > 0) throw new Error(`one-page fonts: ${problems.join("; ")}`)
  await page.locator(".sheet").screenshot({ path: png })
} finally {
  await browser.close()
}
