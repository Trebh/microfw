import { it } from "@effect/vitest"
import { ActionFailure, DispatchRefused, NoSuchStep, type ProposalOf, stepRecordSchema } from "@mufw/core"
import { type Effect, Schema } from "effect"
import { Rpc, RpcClient, RpcGroup, RpcTest } from "effect/rpc"
import { expectTypeOf } from "vitest"
import { Counter, Ports } from "../../core/test/fixtures/Counter.ts"
import { makeRpc, type SamClient, type SamRpcs } from "../src/index.ts"

const CounterRpc = makeRpc(Counter, Ports)

/** The group `RpcGroup.make` infers when it sees the concrete definition's schemas. */
const inferredGroup = RpcGroup.make(
  Rpc.make("Submit", { payload: Counter.intent, error: DispatchRefused }),
  Rpc.make("Present", { payload: Counter.proposal }),
  Rpc.make("Representations", { success: Counter.representation, stream: true }),
  Rpc.make("Dispatch", { payload: Counter.intent, success: Counter.proposal, error: ActionFailure }),
  Rpc.make("History", { success: stepRecordSchema(Counter), stream: true }),
  Rpc.make("TravelTo", { payload: { seq: Schema.Int }, error: NoSuchStep })
)

const exposedGroup = CounterRpc.exposing(["Submit"])

const madeClient = RpcClient.make(CounterRpc.group)

const madeTestClient = RpcTest.makeClient(CounterRpc.group)

type InferredClient = Effect.Success<typeof madeClient>
type InferredTestClient = Effect.Success<typeof madeTestClient>

it("serves the group inferred for the concrete definition", () => {
  expectTypeOf(CounterRpc.group).toExtend<typeof inferredGroup>()
})

it("declares every RPC of the group inferred for the concrete definition", () => {
  expectTypeOf(inferredGroup).toExtend<typeof CounterRpc.group>()
})

it("types an exposed subset as the full group", () => {
  expectTypeOf(exposedGroup).toEqualTypeOf<typeof CounterRpc.group>()
})

it("resolves the client of the group to a client of the contract", () => {
  expectTypeOf<InferredClient>().toExtend<SamClient<typeof Counter>>()
})

it("resolves the in-process client of the group to a client of the contract", () => {
  expectTypeOf<InferredTestClient>().toExtend<SamClient<typeof Counter>>()
})

it("resolves the dispatch handler's result to the runner's result", () => {
  type DispatchResult = Rpc.ResultFrom<Rpc.ExtractTag<SamRpcs<typeof Counter>, "Dispatch">, never>
  type RunnerResult = Effect.Effect<ProposalOf<typeof Counter>, ActionFailure>
  expectTypeOf<RunnerResult>().toExtend<DispatchResult>()
})
