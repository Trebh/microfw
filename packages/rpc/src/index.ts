import {
  ActionFailure,
  type ActionRunnerShape,
  type AnyDefinition,
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
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { Rpc, RpcClient, type RpcClientError, RpcGroup, type RpcSchema, RpcTest } from "effect/rpc"

/** The wire contract, typed from the definition. */
export interface SamClient<D extends AnyDefinition> {
  Submit(intent: IntentOf<D>): Effect.Effect<void, RpcClientError.RpcClientError>
  Present(proposal: ProposalOf<D>): Effect.Effect<void, RpcClientError.RpcClientError>
  Representations(): Stream.Stream<RepresentationOf<D>, RpcClientError.RpcClientError>
  Dispatch(intent: IntentOf<D>): Effect.Effect<ProposalOf<D>, ActionFailure | RpcClientError.RpcClientError>
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
 */
export type SamRpcs<D extends AnyDefinition> =
  | Rpc.Rpc<"Submit", D["intent"]>
  | Rpc.Rpc<"Present", D["proposal"]>
  | Rpc.Rpc<"Representations", Schema.Void, RpcSchema.Stream<D["representation"], Schema.Never>>
  | Rpc.Rpc<"Dispatch", D["intent"], D["proposal"], typeof ActionFailure>
  | Rpc.Rpc<"History", Schema.Void, RpcSchema.Stream<Schema.Codec<StepRecord<D>, unknown>, Schema.Never>>
  | Rpc.Rpc<"TravelTo", Schema.Struct<{ readonly seq: Schema.Int }>, Schema.Void, typeof NoSuchStep>

export const rpcTags = ["Submit", "Present", "Dispatch", "Representations", "History", "TravelTo"] as const
export type RpcTag = typeof rpcTags[number]

/** Annotated because inference through a generic `D` widens the schemas to `any`. */
const makeGroup = <D extends AnyDefinition>(def: D): RpcGroup.RpcGroup<SamRpcs<D>> =>
  RpcGroup.make(
    Rpc.make("Submit", { payload: def.intent }),
    Rpc.make("Present", { payload: def.proposal }),
    Rpc.make("Representations", { success: def.representation, stream: true }),
    Rpc.make("Dispatch", { payload: def.intent, success: def.proposal, error: ActionFailure }),
    Rpc.make("History", { success: stepRecordSchema(def), stream: true }),
    Rpc.make("TravelTo", { payload: { seq: Schema.Int }, error: NoSuchStep })
  )

/** A lost transport is not a domain outcome; it surfaces as a defect. */
const dieOnTransport = <A, E, R>(effect: Effect.Effect<A, E | RpcClientError.RpcClientError, R>) =>
  Effect.catchTag(effect, "RpcClientError", (error) => Effect.die(error)) as Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError>, R>

const remoteModel = <D extends AnyDefinition>(client: SamClient<D>): ModelPortShape<D> => ({
  present: (proposal) => client.Present(proposal).pipe(Effect.orDie),
  representations: Stream.orDie(client.Representations())
})

const remoteHistory = <D extends AnyDefinition>(client: SamClient<D>): HistoryPortShape<D> => ({
  records: Stream.orDie(client.History()),
  travelTo: (seq) => dieOnTransport(client.TravelTo({ seq }))
})

const remoteRunner = <D extends AnyDefinition>(client: SamClient<D>): ActionRunnerShape<D> => ({
  run: (intent) => dieOnTransport(client.Dispatch(intent))
})

const remoteIntents = <D extends AnyDefinition>(client: SamClient<D>): IntentPortShape<D> => ({
  dispatch: (intent) => client.Submit(intent).pipe(Effect.orDie)
})

/**
 * RPC placement of a definition's ports. Transport layers are not here: `layerClient` needs an
 * `RpcClient.Protocol`, the server needs an `RpcServer.Protocol`, both chosen by the app.
 */
export const makeRpc = <D extends AnyDefinition>(def: D, ports: Ports<D>) => {
  const group = makeGroup(def)
  const Client = Context.Service<Client<D>, SamClient<D>>(`${def.name}/rpc/Client`)
  // The generic `D` leaves the group's client type unresolved; `SamClient<D>` is what it resolves to.
  const toSamClient = (client: unknown) => client as SamClient<D>

  const layerClient = Layer.effect(Client, Effect.map(RpcClient.make(group), toSamClient))
  const layerClientTest = Layer.effect(Client, Effect.map(RpcTest.makeClient(group), toSamClient))

  const layerIntentPortRemote = Layer.effect(ports.IntentPort, Client.useSync(remoteIntents))
  const layerModelRemote = Layer.effect(ports.ModelPort, Client.useSync(remoteModel))
  const layerHistoryRemote = Layer.effect(ports.HistoryPort, Client.useSync(remoteHistory))
  const layerActionRunnerRemote = Layer.effect(ports.ActionRunner, Client.useSync(remoteRunner))

  /**
   * The group a server serves: RPCs not listed are not routed, so a client cannot call them. The
   * subset is known only at runtime; typed as the full group, the server requires every handler,
   * which `layerHandlers` provides.
   */
  const exposing = (exposed: ReadonlyArray<RpcTag>): RpcGroup.RpcGroup<SamRpcs<D>> => {
    const hidden = rpcTags.filter((tag) => !exposed.includes(tag))
    return group.omit(...hidden) as unknown as RpcGroup.RpcGroup<SamRpcs<D>>
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
        // The handler result type is a conditional on `D["proposal"]` that only resolves for a concrete `D`.
        Dispatch: (intent) => runner.run(intent) as Rpc.ResultFrom<Rpc.ExtractTag<SamRpcs<D>, "Dispatch">, never>,
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
