import { layerHoldRequestsWhileDisconnected } from "@mufw/rpc"
import { Context, Effect, Layer, Schedule, Stream, SubscriptionRef } from "effect"
import { RpcClient } from "effect/rpc"

export type ConnectionState = "connecting" | "connected" | "disconnected"

/**
 * The transport's state as data, apart from the SAM representation. A page with no remote port
 * provides nothing and reads the default: always connected.
 */
export const Connection = Context.Reference<Stream.Stream<ConnectionState>>("auction/Connection", {
  defaultValue: () => Stream.make("connected")
})

/** Redial with a growing delay capped at five seconds, for as long as the page lives. */
export const reconnectSchedule = Schedule.min([Schedule.exponential("500 millis", 1.5), Schedule.spaced("5 seconds")])

/**
 * The protocol reports each dial's outcome through `ConnectionHooks`; `disconnected` is also
 * reported when a dial never opened, so a page loaded while the server is down shows it.
 */
export const layerConnectionHooks = Layer.effectContext(
  SubscriptionRef.make<ConnectionState>("connecting").pipe(
    Effect.map((state) =>
      Context.make(Connection, SubscriptionRef.changes(state)).pipe(
        Context.add(RpcClient.ConnectionHooks, {
          onConnect: SubscriptionRef.set(state, "connected"),
          onDisconnect: SubscriptionRef.set(state, "disconnected")
        })
      )
    )
  )
)

/**
 * The client protocol over the socket in context: it redials on `reconnectSchedule`, and a dial
 * that cannot open leaves calls pending instead of failing them. A request made after an open
 * connection dropped waits for the next one (`layerHoldRequestsWhileDisconnected`). `Connection`
 * follows the socket.
 */
export const layerProtocol = layerHoldRequestsWhileDisconnected.pipe(
  Layer.provide(RpcClient.layerProtocolSocket({
    retryTransientErrors: true,
    retryPolicy: reconnectSchedule
  })),
  Layer.provideMerge(layerConnectionHooks)
)
