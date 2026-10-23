import { Effect, FiberSet, Layer } from "effect"

export interface StageScaleRoots {
  /** The proscenium: the box the canvas has to fit, letterboxed and centred. */
  readonly frame: HTMLElement
  /** The canvas: laid out at its own fixed size (the stylesheet's `--canvas-w` × `--canvas-h`), scaled by `--stage-scale`. */
  readonly stage: HTMLElement
}

const SCALE_PROPERTY = "--stage-scale"

/** The largest uniform scale that fits the canvas in the frame, or `null` while either has no box. */
const fittingScale = ({ frame, stage }: StageScaleRoots): number | null => {
  const canvasWidth = stage.offsetWidth
  const canvasHeight = stage.offsetHeight
  if (canvasWidth === 0 || canvasHeight === 0) return null
  if (frame.clientWidth === 0 || frame.clientHeight === 0) return null
  return Math.min(frame.clientWidth / canvasWidth, frame.clientHeight / canvasHeight)
}

/** The property is only written when its value changes: the spotlight re-aims on every write. */
const applyScale = (stage: HTMLElement, scale: number) => {
  const value = scale.toFixed(4)
  if (stage.style.getPropertyValue(SCALE_PROPERTY) === value) return
  stage.style.setProperty(SCALE_PROPERTY, value)
}

const fit = (roots: StageScaleRoots) =>
  Effect.sync(() => {
    const scale = fittingScale(roots)
    if (scale !== null) applyScale(roots.stage, scale)
  })

/**
 * Keeps the acts' fixed canvas fitted to the stage frame: `--stage-scale` on the canvas follows the
 * frame's size, whatever the viewport, so every act keeps the box it was designed for.
 */
export const layerStageScale = (roots: StageScaleRoots) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const runFork = yield* FiberSet.makeRuntime()
      const observer = yield* Effect.acquireRelease(
        Effect.sync(() => new ResizeObserver(() => runFork(fit(roots)))),
        (resizes) => Effect.sync(() => resizes.disconnect())
      )
      yield* fit(roots)
      yield* Effect.sync(() => observer.observe(roots.frame))
    })
  )
