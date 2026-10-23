import { html, render } from "uhtml"
import type { Act } from "../act.ts"

/** The page's fixed elements: the chrome, the stage and what plays over it, the prompter's book. */
export interface Skeleton<R> {
  readonly chrome: HTMLElement
  readonly frame: HTMLElement
  readonly stage: HTMLElement
  readonly spotlight: HTMLElement
  readonly bookDrawer: HTMLElement
  readonly bookTab: HTMLElement
  readonly bookPanel: HTMLElement
  /** Each act with the root it plays in, in running order. */
  readonly stages: ReadonlyArray<{ readonly act: Act<R>; readonly root: HTMLElement }>
}

const pick = (host: ParentNode, selector: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(selector)
  // The selectors are this module's own markup: a miss is an authoring bug, not a runtime condition.
  if (found === null) throw new Error(`skeleton: ${selector} is missing`)
  return found
}

const actRoot = (id: string, title: string): HTMLElement => {
  const root = document.createElement("section")
  root.id = `act-${id}`
  root.className = "act"
  root.hidden = true
  root.setAttribute("aria-label", title)
  return root
}

/** Renders the theatre into `host`, with one `section.act` per act inside the stage, all hidden until the curtain shows one. */
export const buildSkeleton = <R>(host: HTMLElement, acts: ReadonlyArray<Act<R>>): Skeleton<R> => {
  render(
    host,
    html`<div id="chrome"></div>
      <div class="stage-frame" data-curtain="open">
        <div class="stage" id="stage"></div>
        <div class="spotlight" data-moving="false" aria-hidden="true"></div>
        <div class="curtain" aria-hidden="true">
          <div class="curtain__half curtain__half--left"></div>
          <div class="curtain__half curtain__half--right"></div>
        </div>
      </div>
      <aside class="book" id="prompter-book" data-open="false" aria-label="The prompter's book" inert>
        <header class="book__head">
          <h2 class="marquee">The prompter's book</h2>
          <p>Every step the deck took tonight, newest first. Click a line and the show itself goes back to it.</p>
        </header>
        <div class="book__panel"></div>
      </aside>
      <div class="book-tab"></div>`
  )
  const stage = pick(host, "#stage")
  const stages = acts.map((act) => {
    const root = actRoot(act.script.id, act.script.title)
    stage.append(root)
    return { act, root }
  })
  return {
    chrome: pick(host, "#chrome"),
    frame: pick(host, ".stage-frame"),
    stage,
    spotlight: pick(host, ".spotlight"),
    bookDrawer: pick(host, "#prompter-book"),
    bookTab: pick(host, ".book-tab"),
    bookPanel: pick(host, ".book__panel"),
    stages
  }
}
