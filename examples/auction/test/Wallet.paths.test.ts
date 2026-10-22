import { describe, it } from "@effect/vitest"
import { AutoActions, layerLoopLocal } from "@mufw/core"
import { makeRpc } from "@mufw/rpc"
import { createTestModel } from "@mufw/test"
import { Effect, Layer } from "effect"
import { Wallet } from "../src/domain/Wallet.ts"
import { WalletPorts } from "../src/ports.ts"
import { walletTestModel } from "./walletModel.ts"

const model = createTestModel(Wallet, WalletPorts, walletTestModel)

const named = (paths: typeof model.shortestPaths) => paths().map((path) => ({ name: model.describe(path), path }))

const Local = layerLoopLocal(Wallet, WalletPorts).pipe(Layer.provide(Layer.succeed(AutoActions, false)))

const WalletRpc = makeRpc(Wallet, WalletPorts)

const Remote = Layer.merge(WalletRpc.layerModelRemote, WalletRpc.layerHistoryRemote).pipe(
  Layer.provide(WalletRpc.layerClientTest),
  Layer.provide(WalletRpc.layerHandlers),
  Layer.provide(Local)
)

describe("wallet, local placement", () => {
  it.effect.each(named(model.shortestPaths))("shortest: $name", ({ path }) => model.run(path).pipe(Effect.provide(Local)))
  it.effect.each(named(model.simplePaths))("simple: $name", ({ path }) => model.run(path).pipe(Effect.provide(Local)))
})

describe("wallet, remote placement (in-process RPC)", () => {
  it.effect.each(named(model.shortestPaths))("shortest: $name", ({ path }) => model.run(path).pipe(Effect.provide(Remote)))
  it.effect.each(named(model.simplePaths))("simple: $name", ({ path }) => model.run(path).pipe(Effect.provide(Remote)))
})
