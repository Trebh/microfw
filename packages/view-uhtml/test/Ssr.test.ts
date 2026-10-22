import { assert, describe, it } from "@effect/vitest"
import { makeSsr } from "../src/ssr.ts"

describe("makeSsr", () => {
  it("renders text and attributes of a template", () => {
    const { html, toString } = makeSsr()

    const markup = toString(html`<p class=${"note big"} data-n=${3}>count: ${7}</p>`)

    assert.strictEqual(markup, `<p class="note big" data-n="3">count: 7</p>`)
  })

  it("renders a boolean attribute only when its value is true", () => {
    const { html, toString } = makeSsr()

    const markup = toString(html`<button ?disabled=${true}>a</button><button ?disabled=${false}>b</button>`)

    assert.strictEqual(markup, `<!--<>--><button disabled>a</button><button>b</button><!--</>-->`)
  })

  it("renders nested templates and arrays of templates", () => {
    const { html, toString } = makeSsr()
    const item = (label: string) => html`<li>${label}</li>`

    const markup = toString(html`<ul>${["a", "b"].map(item)}</ul>`)

    assert.strictEqual(markup, `<ul><li>a</li><li>b</li><!--[2]--></ul>`)
  })

  it("escapes markup in text and attribute values", () => {
    const { html, toString } = makeSsr()
    const hostile = `<script>alert("x")</script>`

    const markup = toString(html`<p title=${hostile}>${hostile}</p>`)

    assert.strictEqual(
      markup,
      `<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>`
    )
  })
})
