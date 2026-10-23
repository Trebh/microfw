import {
  ActionFailure,
  type ActionRunnerShape,
  type AnyDefinition,
  DispatchRefused,
  type HistoryPortShape,
  type IntentOf,
  type IntentPortShape,
  type ModelPortShape,
  NoSuchStep,
  type Ports,
  type ProposalOf,
  type RepresentationOf,
  type StepRecord,
  stepRecordSchema
} from "@mufw/core"
import {
  Cause,
  Context,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Result,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef
} from "effect"
import { Rpc, RpcClient, type RpcClientError, RpcGroup, type RpcMessage, type RpcMiddleware, RpcSchema, RpcTest } from "effect/rpc"

/** A request that carries no identity, or one the server does not accept. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {
  message: Schema.String
}) {}

/**
 * The middleware that authenticates a request before an RPC runs actions. Its error is
 * `Unauthenticated`, so a client sees a typed failure; the services it provides reach the actions.
 */
export type AuthenticationMiddleware = RpcMiddleware.AnyService & { readonly error: typeof Unauthenticated }

/** The wire contract, typed from the definition. */
export interface SamClient<D extends AnyDefinition> {
  Submit(intent: IntentOf<D>): Effect.Effect<void, DispatchRefused | Unauthenticated | RpcClientError.RpcClientError>
  Present(proposal: ProposalOf<D>): Effect.Effect<void, RpcClientError.RpcClientError>
  Representations(): Stream.Stream<RepresentationOf<D>, RpcClientError.RpcClientError>
  Dispatch(
    intent: IntentOf<D>
  ): Effect.Effect<ProposalOf<D>, ActionFailure | Unauthenticated | RpcClientError.RpcClientError>
  History(): Stream.Stream<StepRecord<D>, RpcClientError.RpcClientError>
  TravelTo(payload: { readonly seq: number }): Effect.Effect<void, NoSuchStep | RpcClientError.RpcClientError>
  Replay(payload: { readonly proposals: ReadonlyArray<ProposalOf<D>> }): Effect.Effect<void, RpcClientError.RpcClientError>
}

export interface Client<D extends AnyDefinition> {
  readonly "~mufw/rpc/Client": D
}

/**
 * The wire contract's RPCs. Which ones a server exposes is a deployment decision:
 * - `Submit`: the server runs the actions and its own model (one round trip, nothing trusted from the client)
 * - `Present`: the client runs the actions and the server applies whatever proposal it receives
 * - `Dispatch`: the server runs one action and returns the proposal to a client-side model
 * - `Representations`, `History`: read the server's model
 * - `TravelTo`: rewrite the server's model; development only
 * - `Replay`: apply proposals to the server's model without running its `nap`; development only
 *
 * `Submit` and `Dispatch` run actions, so they carry the authentication middleware `M`, if any.
 */
export type SamRpcs<D extends AnyDefinition, M extends AuthenticationMiddleware = never> =
  | Rpc.Rpc<"Submit", D["intent"], Schema.Void, typeof DispatchRefused, M>
  | Rpc.Rpc<"Present", D["proposal"]>
  | Rpc.Rpc<"Representations", Schema.Void, RpcSchema.Stream<D["representation"], Schema.Never>>
  | Rpc.Rpc<"Dispatch", D["intent"], D["proposal"], typeof ActionFailure, M>
  | Rpc.Rpc<"History", Schema.Void, RpcSchema.Stream<Schema.Codec<StepRecord<D>, unknown>, Schema.Never>>
  | Rpc.Rpc<"TravelTo", Schema.Struct<{ readonly seq: Schema.Int }>, Schema.Void, typeof NoSuchStep>
  | Rpc.Rpc<"Replay", Schema.Struct<{ readonly proposals: Schema.$Array<D["proposal"]> }>>

export const rpcTags = ["Submit", "Present", "Dispatch", "Representations", "History", "TravelTo", "Replay"] as const
export type RpcTag = typeof rpcTags[number]

/**
 * Annotated because inference through a generic `D` widens the schemas to `any`. Whether the
 * middleware is applied is a runtime choice that the types cannot follow, so the group is cast to
 * `SamRpcs<D, M>`, the type that choice produces.
 */
const makeGroup = <D extends AnyDefinition, M extends AuthenticationMiddleware>(
  def: D,
  authentication: M | undefined
): RpcGroup.RpcGroup<SamRpcs<D, M>> => {
  const guarded = <Tag extends string, P extends Schema.Top, S extends Schema.Top, E extends Schema.Top>(
    rpc: Rpc.Rpc<Tag, P, S, E>
  ) => (authentication === undefined ? rpc : rpc.middleware(authentication))
  const group = RpcGroup.make(
    guarded(Rpc.make("Submit", { payload: def.intent, error: DispatchRefused })),
    Rpc.make("Present", { payload: def.proposal }),
    Rpc.make("Representations", { success: def.representation, stream: true }),
    guarded(Rpc.make("Dispatch", { payload: def.intent, success: def.proposal, error: ActionFailure })),
    Rpc.make("History", { success: stepRecordSchema(def), stream: true }),
    Rpc.make("TravelTo", { payload: { seq: Schema.Int }, error: NoSuchStep }),
    Rpc.make("Replay", { payload: { proposals: Schema.Array(def.proposal) } })
  )
  return group as unknown as RpcGroup.RpcGroup<SamRpcs<D, M>>
}

const socketLoss: Record<string, true> = {
  SocketOpenError: true,
  SocketReadError: true,
  SocketWriteError: true,
  SocketCloseError: true
}

/**
 * An HTTP request that never reached the server (`TransportError`) or whose response body was cut
 * (`DecodeError`, what a dropped stream surfaces as). A status error or a malformed body is not a loss.
 */
const httpLoss: Record<string, true> = {
  TransportError: true,
  DecodeError: true
}

const isSocketLost = (error: RpcClientError.RpcClientError) => error.reason._tag in socketLoss

const isConnectionLost = (error: RpcClientError.RpcClientError) => {
  const reason = error.reason
  return reason._tag === "HttpError" ? reason.kind in httpLoss : isSocketLost(error)
}

const redialWhile = (every: Duration.Input, lost: (error: RpcClientError.RpcClientError) => boolean) =>
  Schedule.spaced(every).pipe(
    Schedule.setInputType<RpcClientError.RpcClientError>(),
    Schedule.while(({ input }) => lost(input))
  )

/**
 * A lost connection fails the streams running on it: a dropped socket, which the protocol redials
 * in the background, or an HTTP stream cut or refused, which only a new request replaces. A stream
 * that subscribes again once the server is back resumes. Other client errors (a malformed frame)
 * stay defects.
 */
const resubscribe = redialWhile("1 second", isConnectionLost)

type ClientProtocol = RpcClient.Protocol["Service"]

/** How long a refused request waits before the socket is tried again. */
const holdPoll: Duration.Input = "250 millis"

/** How long a call waits to be written before the page is told it is pending. */
const pendingGrace: Duration.Input = "200 millis"

/**
 * True while a unary call of `Rpc.layerClient` makes its request. The encoded request does not say
 * whether its RPC streams, so the client says so through the fiber that makes the request: the hold
 * layer counts only these requests in `HeldRequests`.
 */
const CountedCall = Context.Reference<boolean>("@mufw/rpc/CountedCall", { defaultValue: () => false })

/**
 * A request waiting for its turn to be written, then for its response. `abandoned` is set by a
 * caller that stopped waiting. `counted` is true for a unary call of `Rpc.layerClient`, and `held`
 * once it has waited past `pendingGrace`. `answer` settles once the request has been written: it
 * succeeds with the response and fails if the connection is lost first; a refused write wrote
 * nothing, so it starts the request over with a fresh `answer`.
 */
interface PendingRequest {
  readonly id: string
  readonly send: Effect.Effect<void, RpcClientError.RpcClientError>
  readonly written: Deferred.Deferred<void, RpcClientError.RpcClientError>
  answer: Deferred.Deferred<void, RpcClientError.RpcClientError>
  abandoned: boolean
  readonly counted: boolean
  held: boolean
}

/**
 * The requests waiting to be written, in the order they were issued, the ones written and not yet
 * answered, and the signal that the protocol's scope has closed. `arrived` is open while `waiting`
 * is not empty; `held` is how many of them have waited past `pendingGrace`.
 */
interface HeldQueue {
  readonly waiting: Array<PendingRequest>
  readonly inFlight: Map<string, PendingRequest>
  readonly arrived: Latch.Latch
  readonly held: SubscriptionRef.SubscriptionRef<number>
  readonly closed: Deferred.Deferred<never>
}

const makeHeldQueue = Effect.gen(function*() {
  const held = yield* SubscriptionRef.make(0)
  const queue: HeldQueue = {
    waiting: [],
    inFlight: new Map(),
    arrived: Latch.makeUnsafe(false),
    held,
    closed: Deferred.makeUnsafe<never>()
  }
  yield* Effect.addFinalizer(() => Deferred.interrupt(queue.closed))
  return queue
})

const enqueue = (queue: HeldQueue, request: PendingRequest) => {
  queue.waiting.push(request)
  queue.arrived.openUnsafe()
}

const publishHeld = (queue: HeldQueue) =>
  SubscriptionRef.set(queue.held, queue.waiting.filter((request) => request.held).length)

const dequeue = (queue: HeldQueue, request: PendingRequest) =>
  Effect.suspend(() => {
    const index = queue.waiting.indexOf(request)
    if (index === -1) return Effect.void
    queue.waiting.splice(index, 1)
    if (queue.waiting.length === 0) queue.arrived.closeUnsafe()
    return publishHeld(queue)
  })

/**
 * A counted request that is still waiting after `pendingGrace` is pending: the socket refused it, or
 * a request ahead of it did, or the first connection has not opened. Any request, however far down
 * the queue, is told apart from one a live socket writes at once only by how long it has waited.
 */
const announceAfterGrace = (queue: HeldQueue, request: PendingRequest) =>
  Effect.sleep(pendingGrace).pipe(
    Effect.andThen(Effect.suspend(() => {
      if (!request.counted || !queue.waiting.includes(request)) return Effect.void
      request.held = true
      return publishHeld(queue)
    }))
  )

/** The first waiting request is read again before every attempt, so a request interrupted while it was refused is not attempted again. */
const nextToWrite = (queue: HeldQueue): Effect.Effect<PendingRequest> =>
  Effect.suspend(() => {
    const next = queue.waiting[0]
    return next === undefined ? queue.arrived.whenOpen(nextToWrite(queue)) : Effect.succeed(next)
  })

/** Only a socket refusal proves the request was not written, so only it may be sent again. */
const refusedForNow = (exit: Exit.Exit<void, RpcClientError.RpcClientError>) => {
  if (Exit.isSuccess(exit)) return false
  const failure = Cause.findError(exit.cause)
  return Result.isSuccess(failure) && isSocketLost(failure.success)
}

/**
 * One attempt to write `request`, which counts as in flight from the moment `send` is invoked: it
 * is in flight when the connection drops under a write already under way. A failed attempt wrote
 * nothing the client can rely on, so it is taken back and starts over with a fresh `answer`.
 */
const attemptWrite = (queue: HeldQueue, request: PendingRequest) =>
  Effect.suspend(() => {
    queue.inFlight.set(request.id, request)
    return request.send.pipe(Effect.tapError(() =>
      Effect.sync(() => {
        queue.inFlight.delete(request.id)
        request.answer = Deferred.makeUnsafe()
      })
    ))
  })

/**
 * Writes the first waiting request. `send` decides on the call, not when the effect it returns
 * runs: it reads the protocol's last socket error and encodes the frame as it is invoked, so each
 * attempt calls it again. An abandoned request is not attempted, so a request interrupted while it
 * waits is never written. A refused one stays first and is tried again after `holdPoll`.
 */
const writeNext = (queue: HeldQueue) =>
  Effect.gen(function*() {
    const request = yield* nextToWrite(queue)
    const exit = yield* Effect.exit(Effect.suspend(() => (request.abandoned ? Effect.void : attemptWrite(queue, request))))
    if (refusedForNow(exit)) return yield* Effect.sleep(holdPoll)
    yield* dequeue(queue, request)
    yield* Deferred.done(request.written, exit)
  })

/**
 * Enqueues the request and waits until it is written and then answered. Waiting for the answer is
 * what lets the layer fail this request, and no other, when the connection drops under it: the
 * client's call fails with the error this effect fails with.
 */
const waitUntilAnswered = (queue: HeldQueue, id: string, send: PendingRequest["send"]) =>
  Effect.gen(function*() {
    const counted = yield* CountedCall
    const request: PendingRequest = {
      id,
      send,
      written: Deferred.makeUnsafe(),
      answer: Deferred.makeUnsafe(),
      abandoned: false,
      counted,
      held: false
    }
    enqueue(queue, request)
    const announced = yield* Effect.forkChild(announceAfterGrace(queue, request))
    const answered = Deferred.await(request.written).pipe(Effect.andThen(Effect.suspend(() => Deferred.await(request.answer))))
    return yield* Effect.raceFirst(answered, Deferred.await(queue.closed)).pipe(
      Effect.ensuring(Effect.suspend(() => {
        request.abandoned = true
        if (queue.inFlight.get(id) === request) queue.inFlight.delete(id)
        return Fiber.interrupt(announced).pipe(Effect.andThen(dequeue(queue, request)))
      }))
    )
  })

/** The request whose response arrived is answered and no longer in flight. */
const answerRequest = (queue: HeldQueue, requestId: string | number) => {
  const key = String(requestId)
  const request = queue.inFlight.get(key)
  if (request === undefined) return
  queue.inFlight.delete(key)
  Deferred.doneUnsafe(request.answer, Effect.void)
}

/** Every request written and not yet answered fails with the error of the lost connection. */
const failInFlight = (queue: HeldQueue, error: RpcClientError.RpcClientError) => {
  for (const request of queue.inFlight.values()) Deferred.doneUnsafe(request.answer, Effect.fail(error))
  queue.inFlight.clear()
}

/**
 * What the client is told. The protocol broadcasts the error of a dropped socket, which fails every
 * call the client has in flight, written or not; the layer keeps it from the client and fails the
 * written requests itself (`waitUntilAnswered`), so a request still queued is written after the
 * next connection. Any other message reaches the client unchanged.
 */
const reportingToClient = (queue: HeldQueue, report: (message: RpcMessage.FromServerEncoded) => Effect.Effect<void>) =>
  (message: RpcMessage.FromServerEncoded): Effect.Effect<void> => {
    if (message._tag === "Exit") answerRequest(queue, message.requestId)
    if (message._tag === "ClientProtocolError" && isSocketLost(message.error)) {
      failInFlight(queue, message.error)
      return Effect.void
    }
    return report(message)
  }

/**
 * Every request goes through one queue and one writer fiber, which is what makes the order strict:
 * a lock would not, because `Semaphore` wakes its waiters from a scheduled task, and a request
 * issued before that task runs finds the permit free and overtakes the waiter. The caller waits for
 * its request to be written and answered. Interrupting it marks the request abandoned
 * (a write already under way completes, as the writer fiber is not the caller's). Once the scope
 * has closed the writer is gone, so a caller still waiting, and any later one, is interrupted, as
 * `RpcClient` interrupts its own calls when its scope closes. The other messages skip the queue:
 * an interrupt follows the fiber that wrote (or abandoned) its request, and an ack answers a
 * response of the live connection, which a held write must not stall.
 */
const holdRequest = (protocol: ClientProtocol, queue: HeldQueue): ClientProtocol => ({
  ...protocol,
  run: (clientId, report) => protocol.run(clientId, reportingToClient(queue, report)),
  send: (clientId, message, transferables) => {
    if (message._tag !== "Request") return Effect.suspend(() => protocol.send(clientId, message, transferables))
    const write = Effect.suspend(() => protocol.send(clientId, message, transferables))
    return waitUntilAnswered(queue, String(message.id), write)
  }
})

/**
 * How many unary calls (`Submit`, `Present`, `Dispatch`, `TravelTo`, `Replay`) have waited more
 * than 200 ms to be written: the socket is down, or has not opened yet. A stream subscription waiting
 * to resubscribe is not counted: it carries no intent. A page that reads it can say that an intent
 * is pending without the domain knowing: the call waits as it always did.
 * `layerHoldRequestsWhileDisconnected` provides it; with no such layer it reads 0.
 */
export const HeldRequests = Context.Reference<Stream.Stream<number>>("@mufw/rpc/HeldRequests", {
  defaultValue: () => Stream.make(0)
})

/**
 * Wraps the client protocol beneath it so that a request made while the socket is down waits for
 * the connection and is then sent once, in the order the requests were issued: one fiber per
 * protocol writes the requests from a queue, retries included, so a later request, held or live,
 * is written after an earlier held one. Writing does not wait for the response, so round trips
 * stay concurrent. The socket protocol refuses a `send` with the socket error only before
 * writing anything (`RpcClient.makeProtocolSocket` keeps the last error until a redial succeeds,
 * and a write that fails is a defect), so that refusal is the signal that the server cannot have
 * received the request and retrying it cannot apply it twice.
 *
 * The inner protocol MUST be `RpcClient.layerProtocolSocket({ retryTransientErrors: true,
 * retryPolicy })` with a `retryPolicy` that never ends. Without `retryTransientErrors` a failed
 * redial is broadcast as a client error and fails the held requests; with a policy that runs out,
 * the protocol stops redialling while the held requests keep retrying every 250 ms for good.
 *
 * A request already written when the socket drops is not retried: the server may have run it, and
 * `Submit`, `Present`, `Dispatch` and `Replay` are not idempotent. It fails with the socket error, which
 * the remote ports turn into a defect. Interrupt, ack and end messages are neither held nor
 * queued.
 *
 * The protocol broadcasts the error of a dropped socket to every call the client has in flight,
 * including the requests not written yet. The layer withholds that broadcast from the client and
 * fails only the requests it had written, each through its own `send`, with the socket error: so
 * a request still queued survives any number of drops whichever client made it, `Rpc.layerClient`
 * or one built by `RpcClient.make` elsewhere. A `send` therefore returns when the response has
 * arrived, not when the request is written. Only the unary calls of `Rpc.layerClient` are counted
 * in `HeldRequests`.
 */
export const layerHoldRequestsWhileDisconnected: Layer.Layer<RpcClient.Protocol, never, RpcClient.Protocol> =
  Layer.effectContext(
    Effect.gen(function*() {
      const protocol = yield* RpcClient.Protocol
      const queue = yield* makeHeldQueue
      yield* Effect.forkScoped(Effect.forever(writeNext(queue)))
      return Context.make(RpcClient.Protocol, holdRequest(protocol, queue)).pipe(
        Context.add(HeldRequests, Stream.changes(SubscriptionRef.changes(queue.held)))
      )
    })
  )

type UnaryCall = (payload: unknown, options?: unknown) => Effect.Effect<unknown, unknown>

/**
 * The client's unary calls made as counted calls (`CountedCall`); its stream calls are left as they
 * are, since a stream resubscribes (`resumable`) and carries no intent to count.
 */
const countingUnaryCalls = (calls: Record<string, unknown>, streams: ReadonlySet<string>): Record<string, unknown> => {
  const counting: Record<string, unknown> = {}
  for (const [tag, call] of Object.entries(calls)) {
    const unary = call as UnaryCall
    counting[tag] = streams.has(tag)
      ? call
      : (payload: unknown, options?: unknown) => Effect.provideService(unary(payload, options), CountedCall, true)
  }
  return counting
}

const resumable = <A>(stream: Stream.Stream<A, RpcClientError.RpcClientError>) =>
  stream.pipe(Stream.retry(resubscribe), Stream.catchTag("RpcClientError", Stream.die))

interface Delivered {
  initAt: number | undefined
  seq: number
}

/**
 * After a resubscription the server replays its retained history: records already delivered are
 * dropped, and a new `init` record (a restarted server) starts the sequence over.
 */
const undelivered = <D extends AnyDefinition>(delivered: Delivered, record: StepRecord<D>) => {
  if (record.kind === "init" && record.at !== delivered.initAt) {
    delivered.initAt = record.at
    delivered.seq = -1
  }
  if (record.seq <= delivered.seq) return false
  delivered.seq = record.seq
  return true
}

/** A call that finds the transport lost is not a domain outcome; it surfaces as a defect. */
const remoteModel = <D extends AnyDefinition>(client: SamClient<D>): ModelPortShape<D> => ({
  present: (proposal) => client.Present(proposal).pipe(Effect.catchTag("RpcClientError", Effect.die)),
  representations: resumable(client.Representations())
})

const remoteHistory = <D extends AnyDefinition>(client: SamClient<D>): HistoryPortShape<D> => ({
  records: Stream.suspend(() => {
    const delivered: Delivered = { initAt: undefined, seq: -1 }
    return resumable(client.History().pipe(Stream.filter((record) => undelivered(delivered, record))))
  }),
  travelTo: (seq) => client.TravelTo({ seq }).pipe(Effect.catchTag("RpcClientError", Effect.die)),
  replay: (proposals) => client.Replay({ proposals }).pipe(Effect.catchTag("RpcClientError", Effect.die))
})

/** The remote runner has no identity channel of its own: a refused identity is a failed action. */
const remoteRunner = <D extends AnyDefinition>(client: SamClient<D>): ActionRunnerShape<D> => ({
  run: (intent) =>
    client.Dispatch(intent).pipe(
      Effect.catchTags({
        RpcClientError: Effect.die,
        Unauthenticated: (refused) =>
          Effect.fail(new ActionFailure({ intentTag: intent._tag, message: refused.message }))
      })
    )
})

/** A refused session is a refused dispatch, which a page can show; a lost transport is a defect. */
const remoteIntents = <D extends AnyDefinition>(client: SamClient<D>): IntentPortShape<D> => ({
  dispatch: (intent) =>
    client.Submit(intent).pipe(
      Effect.catchTags({
        RpcClientError: Effect.die,
        Unauthenticated: (refused) =>
          Effect.fail(new DispatchRefused({ intentTag: intent._tag, message: refused.message }))
      })
    )
})

/**
 * How many representations a served `Representations` stream holds for a client that is not taking
 * them: the newest ones, so a client that falls behind skips to the latest snapshots instead of
 * making the server keep every one. Without it the stream would hold each representation until the
 * client acks, and a client that stops acking never releases them. An application sets it, as a
 * layer, where it composes the handlers; below 1 is 1. `History` has no such option: its records
 * are not snapshots, so what a subscriber falls behind on is read back from the history's retention
 * (`HistoryBacklog` in `@mufw/core`) instead of being skipped.
 */
export const RepresentationBacklog = Context.Reference<number>("@mufw/rpc/RepresentationBacklog", {
  defaultValue: () => 64
})

/**
 * RPC placement of a definition's ports. Transport layers are not here: `layerClient` needs an
 * `RpcClient.Protocol`, the server needs an `RpcServer.Protocol`, both chosen by the app.
 *
 * `authentication` guards `Submit` and `Dispatch`, the RPCs that run actions: a server needs its
 * implementation, which provides the request's services to the actions, and a client needs the
 * matching client layer, which sends the credentials with every request.
 *
 * `R` is the per-request services of `ports`. The handlers of `Submit` and `Dispatch` need them,
 * and `layerHandlers` leaves a requirement only for the ones `authentication` does not provide.
 */
export const makeRpc = <D extends AnyDefinition, M extends AuthenticationMiddleware = never, R = never>(
  def: D,
  ports: Ports<D, R>,
  authentication?: M
) => {
  const group = makeGroup(def, authentication)
  const Client = Context.Service<Client<D>, SamClient<D>>(`${def.name}/rpc/Client`)
  // Over a generic `D` the client's `Dispatch` is an unresolved conditional on `D["proposal"]`; for a
  // concrete `D` it is `SamClient<D>`'s, which Rpc.types.test.ts checks.
  const toSamClient = (client: RpcClient.RpcClient<SamRpcs<D, M>, RpcClientError.RpcClientError>) =>
    client as SamClient<D>

  const streams = new Set<string>()
  for (const [tag, rpc] of group.requests) {
    if (RpcSchema.isStreamSchema((rpc as unknown as Rpc.AnyWithProps).successSchema)) streams.add(tag)
  }

  const layerClient = Layer.effect(
    Client,
    Effect.gen(function*() {
      const client = yield* RpcClient.make(group)
      // Wrapped by tag, so an RPC added to the group is covered; the result has the shape `client` has.
      const counting = countingUnaryCalls(client as unknown as Record<string, unknown>, streams)
      return toSamClient(counting as unknown as typeof client)
    })
  )
  const layerClientTest = Layer.effect(Client, Effect.map(RpcTest.makeClient(group), toSamClient))

  const layerIntentPortRemote = Layer.effect(ports.IntentPort, Client.useSync(remoteIntents))
  const layerModelRemote = Layer.effect(ports.ModelPort, Client.useSync(remoteModel))
  const layerHistoryRemote = Layer.effect(ports.HistoryPort, Client.useSync(remoteHistory))
  const layerActionRunnerRemote = Layer.effect(ports.ActionRunner, Client.useSync(remoteRunner))

  /**
   * The group a server serves: RPCs not listed are not routed, so a client cannot call them. The
   * subset is known only at runtime, so `omit` types it as the empty group; the cast restores the
   * full group, whose handlers `layerHandlers` provides (Rpc.types.test.ts pins the type).
   */
  const exposing = (exposed: ReadonlyArray<RpcTag>): RpcGroup.RpcGroup<SamRpcs<D, M>> => {
    const hidden = rpcTags.filter((tag) => !exposed.includes(tag))
    return group.omit(...hidden) as unknown as RpcGroup.RpcGroup<SamRpcs<D, M>>
  }

  const layerHandlers = group.toLayer(
    Effect.gen(function*() {
      const intents = yield* ports.IntentPort
      const model = yield* ports.ModelPort
      const history = yield* ports.HistoryPort
      const runner = yield* ports.ActionRunner
      const backlog = Math.max(1, yield* RepresentationBacklog)
      return group.of({
        Submit: (intent) => intents.dispatch(intent),
        Present: (proposal) => model.present(proposal),
        Representations: () => model.representations.pipe(Stream.buffer({ capacity: backlog, strategy: "sliding" })),
        // `ResultFrom` is a conditional on `D["proposal"]` that only resolves for a concrete `D`, where it
        // admits the runner's `Effect<ProposalOf<D>, ActionFailure, R>` (Rpc.types.test.ts).
        Dispatch: (intent) => runner.run(intent) as Rpc.ResultFrom<Rpc.ExtractTag<SamRpcs<D, M>, "Dispatch">, R>,
        History: () => history.records,
        TravelTo: ({ seq }) => history.travelTo(seq),
        Replay: ({ proposals }) => history.replay(proposals)
      })
    })
  )

  return {
    group,
    exposing,
    Client,
    layerClient,
    layerClientTest,
    layerIntentPortRemote,
    layerModelRemote,
    layerHistoryRemote,
    layerActionRunnerRemote,
    layerHandlers
  }
}
