import { BrowserRuntime, BrowserWorkerRunner } from "@effect/platform-browser"
import { layerLoopLocal } from "@mufw/core"
import { Cause, Exit, Layer, Runtime } from "effect"
import { RpcServer } from "effect/rpc"
import { backstage } from "./backstage.ts"
import { WINGS_RPCS, wings, wingsRpc } from "./stages.ts"

/**
 * The page learns of a worker's death only from an `error` event on the `Worker`, which an uncaught
 * error raises; a failed `runMain` only logs and leaves the worker idle, still reported as ready.
 * So a failure is re-raised as an error event, and the worker closes, since it serves nothing.
 */
const reportFailureToPage: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
    reportError(Cause.squash(exit.cause))
    close()
  }
  Runtime.defaultTeardown(exit, onExit)
}

/** The company in the wings: its own box office loop, gateway and patron, behind the worker's RPC protocol. */
const served = RpcServer.layer(wingsRpc.exposing(WINGS_RPCS)).pipe(
  Layer.provide(wingsRpc.layerHandlers),
  Layer.provide(layerLoopLocal(wings.def, wings.ports)),
  Layer.provide(backstage),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BrowserWorkerRunner.layer)
)

/** The worker's composition root: serves the company in the wings over the page's message channel until the page closes. */
BrowserRuntime.runMain(Layer.launch(served), { teardown: reportFailureToPage })
