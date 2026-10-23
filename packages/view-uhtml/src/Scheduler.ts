import { Layer } from "effect"
import { MixedScheduler, Scheduler } from "effect/Scheduler"

/**
 * Milliseconds of fiber work that run as microtasks before the scheduler hands control back to the
 * event loop. One click's hops (queue wake, fork of the present, the render) cost well under a
 * millisecond, so they always fit; 5 ms leaves most of a 16.7 ms frame to the browser for input
 * and paint when a fiber keeps working.
 */
export const inputBudgetMillis = 5

type Cancel = () => void
type Defer = (task: () => void) => Cancel

const queueMicrotaskCancellable: Defer = (task) => {
  let cancelled = false
  queueMicrotask(() => {
    if (!cancelled) task()
  })
  return () => {
    cancelled = true
  }
}

const setTimeoutCancellable: Defer = (task) => {
  const timer = setTimeout(task, 0)
  return () => clearTimeout(timer)
}

/**
 * The `setImmediate` of a `MixedScheduler`: runs a task as a microtask while the fiber work since the
 * last window reset has taken less than `budgetMillis`, as a macrotask beyond it. A window opens
 * with the first task it defers and closes when a macrotask posted then runs, or when the one
 * that yielded runs, whichever is first. The budget counts the time the deferred tasks take, not
 * the time elapsed, so a page that sits idle between clicks keeps a full budget for each. Time is
 * read here and not through `Clock`: this is the scheduler primitive, below effectful code.
 */
const makeInputDefer = (budgetMillis: number, now: () => number): Defer => {
  let busyMillis = 0
  let resetPending = false

  const reset = () => {
    busyMillis = 0
    resetPending = false
  }
  const timed = (task: () => void) => () => {
    const start = now()
    try {
      task()
    } finally {
      busyMillis += now() - start
    }
  }

  return (task) => {
    if (busyMillis >= budgetMillis) {
      return setTimeoutCancellable(() => {
        reset()
        timed(task)()
      })
    }
    if (!resetPending) {
      resetPending = true
      setTimeoutCancellable(reset)
    }
    return queueMicrotaskCancellable(timed(task))
  }
}

/**
 * A scheduler for a page that handles input. Effect's default `MixedScheduler` posts every fiber
 * hop as a macrotask, and a browser holds a macrotask posted from an input event until the next
 * frame, so a click would show its step one frame late. This one runs the hops of a click as
 * microtasks, in the task of the event, and moves to a macrotask once fibers have worked for
 * `inputBudgetMillis`, so a busy fiber cannot starve input or rendering.
 */
const makeInputScheduler = (): MixedScheduler =>
  new MixedScheduler("async", makeInputDefer(inputBudgetMillis, () => performance.now()))

/**
 * Provides `makeInputScheduler()` as the `Scheduler` of every fiber the layer it is provided to
 * builds or forks. Provide it last, around the whole composition, with `Layer.provide`: a queue
 * keeps the dispatcher of the fiber that created it, so a layer built beneath this one (the loop
 * of a placement) is only reached when this wraps it.
 */
export const layerInputScheduler = Layer.sync(Scheduler, makeInputScheduler)
