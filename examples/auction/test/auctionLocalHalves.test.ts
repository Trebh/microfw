import { assert, describe, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { clientSources, misplacedLocalHalves } from "../scripts/auctionLocalHalves.ts"

const root = new URL("..", import.meta.url).pathname

const page = (path: string, text: string) => ({ path, text })

const calls = (path: string, text: string) =>
  misplacedLocalHalves([page(path, text)]).map(({ line, call }) => `${line}:${call}`)

describe("misplacedLocalHalves", () => {
  it("flags a page that builds the auction's local model", () => {
    const text = [
      `import { layerModelLocal } from "@mufw/core"`,
      `import { Auction } from "../auction/Auction.ts"`,
      `import { Ports } from "../ports.ts"`,
      `export const model = layerModelLocal(Auction, Ports)`
    ].join("\n")

    assert.deepStrictEqual(calls("src/client/page.ts", text), ["4:layerModelLocal"])
  })

  it("flags a page that builds the auction's local action runner", () => {
    const text = [
      `import { layerActionRunnerLocal } from "@mufw/core"`,
      `import { Auction } from "../../auction/Auction.ts"`,
      `import { Ports } from "../../ports.ts"`,
      `export const runner = layerActionRunnerLocal(Auction, Ports)`
    ].join("\n")

    assert.deepStrictEqual(calls("src/client/placements/other.ts", text), ["4:layerActionRunnerLocal"])
  })

  it("flags a page that builds the auction's local loop", () => {
    const text = [
      `import { layerLoopLocal } from "@mufw/core"`,
      `import { Auction } from "../auction/Auction.ts"`,
      `import { ServerPorts } from "../serverPorts.ts"`,
      `export const loop = layerLoopLocal(Auction, ServerPorts)`
    ].join("\n")

    assert.deepStrictEqual(calls("src/client/worker.ts", text), ["4:layerLoopLocal"])
  })

  it("flags a builder and a definition imported under another name", () => {
    const text = [
      `import { layerModelLocal as local } from "@mufw/core"`,
      `import { Auction as TheAuction } from "../auction/Auction.ts"`,
      `export const model = local(TheAuction, Ports)`
    ].join("\n")

    assert.deepStrictEqual(calls("src/client/page.ts", text), ["3:local"])
  })

  it("flags a builder and a definition reached through namespace imports", () => {
    const text = [
      `import * as core from "@mufw/core"`,
      `import * as auction from "../auction/Auction.ts"`,
      `export const model = core.layerModelLocal(auction.Auction, Ports)`
    ].join("\n")

    assert.deepStrictEqual(calls("src/client/page.ts", text), ["3:core.layerModelLocal"])
  })

  it("flags a definition held in a const", () => {
    const text = [
      `import { layerModelLocal } from "@mufw/core"`,
      `import { Auction } from "../auction/Auction.ts"`,
      `const definition = Auction`,
      `export const model = layerModelLocal(definition, Ports)`
    ].join("\n")

    assert.deepStrictEqual(calls("src/client/page.ts", text), ["4:layerModelLocal"])
  })

  it("flags a half built inside a nested function", () => {
    const text = [
      `import { layerModelLocal } from "@mufw/core"`,
      `import { Auction } from "../auction/Auction.ts"`,
      `export const model = (ports: unknown) => Layer.unwrap(Effect.sync(() => layerModelLocal(Auction, ports)))`
    ].join("\n")

    assert.deepStrictEqual(calls("src/client/page.ts", text), ["3:layerModelLocal"])
  })

  it("lets auctionLocal.ts build the auction's halves", () => {
    const text = readFileSync(`${root}src/client/placements/auctionLocal.ts`, "utf8")

    assert.deepStrictEqual(calls("src/client/placements/auctionLocal.ts", text), [])
  })

  it("flags the halves auctionLocal.ts builds when they sit in another module", () => {
    const text = readFileSync(`${root}src/client/placements/auctionLocal.ts`, "utf8")
    const flagged = misplacedLocalHalves([page("src/client/placements/copy.ts", text)]).map(({ call }) => call)

    assert.deepStrictEqual([...new Set(flagged)], ["layerModelLocal", "layerActionRunnerLocal", "layerLoopLocal"])
  })

  it("does not flag the wallet's loop", () => {
    const text = [
      `import { layerLoopLocal } from "@mufw/core"`,
      `import { Wallet } from "../../wallet/Wallet.ts"`,
      `export const wallet = layerLoopLocal(Wallet, WalletPorts)`
    ].join("\n")

    assert.deepStrictEqual(calls("src/client/placements/walletBrowserOnly.ts", text), [])
  })

  it("does not flag a call with another module's Auction", () => {
    const text = [
      `import { layerModelLocal } from "@mufw/core"`,
      `import { Auction } from "./elsewhere.ts"`,
      `export const model = layerModelLocal(Auction, Ports)`
    ].join("\n")

    assert.deepStrictEqual(calls("src/client/page.ts", text), [])
  })

  it("does not flag the server, which composes its own halves", () => {
    const text = [
      `import { layerLoopLocal } from "@mufw/core"`,
      `import { Auction } from "./auction/Auction.ts"`,
      `export const loop = layerLoopLocal(Auction, ServerPorts)`
    ].join("\n")

    assert.deepStrictEqual(calls("src/persistence.ts", text), [])
  })
})

describe("the example's client", () => {
  it("builds the auction's local halves only in placements/auctionLocal.ts", () => {
    assert.deepStrictEqual(misplacedLocalHalves(clientSources(root)), [])
  })

  it("reads placements/auctionLocal.ts, the control that the scan sees the client", () => {
    const paths = clientSources(root).map((source) => source.path)

    assert.include(paths, "src/client/placements/auctionLocal.ts")
  })
})
