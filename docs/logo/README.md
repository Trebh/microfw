# µFW logo

The mark is the SAM step as a ring: four arcs sized to the phases of one step —
**action** (orange, the only effectful part), **model** (purple, data),
**state** and **nap** (blue, pure) — around a monoline µ. Gaps between the arcs
are the seams where the loop can be cut and placed across the network.

## Files

| file | use |
| --- | --- |
| `mark.svg` | the mark on light backgrounds (ink µ) |
| `mark-dark.svg` | the mark on dark backgrounds (cream µ, lighter purple) |
| `mark-mono.svg` | one colour, `currentColor`: inline it in HTML so it inherits the text colour (as an `<img>` it renders black) |
| `mark-two-tone.svg` | `currentColor` ring and µ, orange action arc |
| `favicon.svg` | ring only, heavier strokes; reads at 16 px |
| `icon-512.svg` | app icon / GitHub avatar: the mark on an ink rounded square |
| `lockup.svg` · `lockup-dark.svg` · `lockup-mono.svg` | mark + "µFW" + tagline, 480×160 |

The lockups' text is outlined into paths (IBM Plex Serif SemiBold for the
wordmark, IBM Plex Sans Medium for the tagline, both under the SIL Open Font
License), so they render the same wherever an `<img>` cannot load a font: GitHub,
npm, PDFs.

`favicon.svg` is copied to `examples/auction/src/client/favicon.svg` and
`examples/showcase/src/favicon.svg`, because Vite serves a page's icon only from
inside its project; the poster (`docs/one-page.html`) inlines `mark.svg`. Change
those with this one.

## Colours

The poster's palette, so the logo matches the diagrams.

| name | hex | role |
| --- | --- | --- |
| ink | `#1b1f2a` | µ and text on light |
| paper | `#f6f3ec` | µ and text on dark; light ground |
| pure | `#2563eb` | state + nap arcs |
| data | `#7c3aed` (`#a78bfa` on dark) | model arc |
| effect | `#e8590c` | action arc |

## Geometry

160-unit viewBox. Ring radius 58, stroke 16. Arcs clockwise from 12 o'clock:
action 60°, model 120°, state 90°, nap 60°, gaps 6°. µ: 12-unit monoline,
round caps; stems at x=58 and x=102, bowl radius 22, descender to y=118, foot
to x=116. Clear space: half the ring's diameter on every side, except beside
its own wordmark. Don't rotate the ring: the action arc sits at the top-right.
