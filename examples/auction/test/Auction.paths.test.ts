import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { layerAuthenticationServer } from "../src/adapters/authenticationServer.ts"
import { layerSessionsTable } from "../src/adapters/sessionsTable.ts"
import { layerAuthenticationClient } from "../src/authentication.ts"
import { SessionToken } from "../src/domain/Values.ts"
import { Rpc } from "../src/ports.ts"
import { auctionModel as model, clockedIntentDriver, currentRepresentation, Local, named } from "./drivers.ts"

const Remote = Layer.merge(Rpc.layerModelRemote, Rpc.layerHistoryRemote).pipe(
  Layer.provide(Rpc.layerClientTest),
  Layer.provide(layerAuthenticationClient(SessionToken.make("demo-alice"))),
  Layer.provide(Rpc.layerHandlers),
  Layer.provide(layerAuthenticationServer.pipe(Layer.provide(layerSessionsTable))),
  Layer.provide(Local)
)

describe("local placement", () => {
  it.effect.each(named(model.shortestPaths))("shortest: $name", ({ path }) => model.run(path).pipe(Effect.provide(Local)))
  it.effect.each(named(model.simplePaths))("simple: $name", ({ path }) => model.run(path).pipe(Effect.provide(Local)))
})

describe("remote placement (in-process RPC)", () => {
  it.effect.each(named(model.shortestPaths))("shortest: $name", ({ path }) => model.run(path).pipe(Effect.provide(Remote)))
  it.effect.each(named(model.simplePaths))("simple: $name", ({ path }) => model.run(path).pipe(Effect.provide(Remote)))
})

describe("intent driver", () => {
  it.effect("reaches sold through the real actions", () =>
    Effect.gen(function*() {
      const toSold = model.shortestPaths().find((path) => path.target === "sold")!

      yield* model.run(toSold, clockedIntentDriver)

      assert.strictEqual((yield* currentRepresentation).controlState, "sold")
    }).pipe(Effect.provide(Local)))
})
