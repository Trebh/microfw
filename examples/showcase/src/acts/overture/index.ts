import { Effect, Layer } from "effect"
import { html, render } from "uhtml"
import type { Act } from "../../act.ts"
import { cast, type CastMember } from "../../deck/cast.ts"
import "./style.css"
import { script } from "./script.ts"

const hints: ReadonlyArray<readonly [keys: ReadonlyArray<string>, does: string]> = [
  [["→", "Space"], "next cue"],
  [["←"], "back one cue"],
  [["1", "…", "9"], "jump to an act"],
  [["A"], "autoplay: the prompter reads the show"],
  [["B"], "the prompter's book"],
  [["Home"], "back to the overture"]
]

const castMember = (member: CastMember, index: number) =>
  html`<li class="overture__member" data-spot=${`cast-${member.id}`} style=${`--i:${index}`}>
    <span class="overture__number mono">${String(index + 1).padStart(2, "0")}</span>
    <span class="overture__name">${member.name}</span>
    <span class="overture__role">${member.role}</span>
    <code class="overture__code mono">${member.code}</code>
  </li>`

const hint = ([keys, does]: (typeof hints)[number]) =>
  html`<div class="overture__hint">
    <dt>${keys.map((key) => html`<kbd>${key}</kbd>`)}</dt>
    <dd>${does}</dd>
  </div>`

const playbill = () =>
  html`<div class="overture">
    <header class="overture__masthead">
      <p class="overture__kicker marquee">Tonight · a play in seven acts</p>
      <h1 class="overture__title" data-spot="title">µFW</h1>
      <p class="overture__subtitle" data-spot="subtitle">a play for one model and any number of stages</p>
    </header>
    <section class="overture__cast" aria-labelledby="overture-cast">
      <h2 class="overture__heading marquee" id="overture-cast">The cast <span class="past-35">in order of appearance</span></h2>
      <ol class="overture__members">${cast.map(castMember)}</ol>
    </section>
    <section class="overture__how" data-spot="hints" aria-labelledby="overture-how">
      <h2 class="overture__heading marquee" id="overture-how">How to watch</h2>
      <dl class="overture__hints">${hints.map(hint)}</dl>
    </section>
  </div>`

/** The playbill cover. Static: the spotlight walks its cast, nothing in it reacts. */
export const overtureAct: Act = {
  script,
  layer: (root) => Layer.effectDiscard(Effect.sync(() => render(root, playbill())))
}
