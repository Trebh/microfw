import { html, render } from "uhtml"

/** The plain baseline of `counter-mufw`: uhtml, one state variable, one render function, no `effect`. */
let count = 0

const root = document.getElementById("app")!

const view = () => html`<button id="inc" onclick=${increment}>+1</button><output id="count">${count}</output>`

const paint = () => render(root, view())

function increment() {
  count += 1
  paint()
}

paint()
