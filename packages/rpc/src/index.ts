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
import { Context, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { Rpc, RpcClient, type RpcClientError, RpcGroup, type RpcMiddleware, type RpcSchema, RpcTest } from "effect/rpc"

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

export const rpcTags = ["Submit", "Present", "Dispatch", "Representations", "History", "TravelTo"] as const
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
    Rpc.make("TravelTo", { payload: { seq: Schema.Int }, error: NoSuchStep })
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
 * A dropped socket fails the streams running on it; the protocol redials in the background, and
 * a stream that subscribes again once it is back resumes. Other client errors (a malformed
 * frame) stay defects.
 */
const resubscribe = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<RpcClientError.RpcClientError>(),
  Schedule.while(({ input }) => input.reason._tag in socketLoss)
)

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
  travelTo: (seq) => client.TravelTo({ seq }).pipe(Effect.catchTag("RpcClientError", Effect.die))
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

  const layerClient = Layer.effect(Client, Effect.map(RpcClient.make(group), toSamClient))
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
      return group.of({
        Submit: (intent) => intents.dispatch(intent),
        Present: (proposal) => model.present(proposal),
        Representations: () => model.representations,
        // `ResultFrom` is a conditional on `D["proposal"]` that only resolves for a concrete `D`, where it
        // admits the runner's `Effect<ProposalOf<D>, ActionFailure, R>` (Rpc.types.test.ts).
        Dispatch: (intent) => runner.run(intent) as Rpc.ResultFrom<Rpc.ExtractTag<SamRpcs<D, M>, "Dispatch">, R>,
        History: () => history.records,
        TravelTo: ({ seq }) => history.travelTo(seq)
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
