import assert from "node:assert/strict"
import { NodeRuntime, NodeSocket } from "@effect/platform-node"
import type { ModelPortShape } from "@mufw/core"
import { Console, Context, Effect, Layer, Option, Schedule, Stream } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { type ChildProcess, spawn } from "node:child_process"
import { connect } from "node:net"
import { fileURLToPath } from "node:url"
import { layerAuthenticationClient } from "../src/authentication.ts"
import { Auction, type Representation } from "../src/domain/Auction.ts"
import { SessionToken } from "../src/domain/Values.ts"
import { Ports, Rpc } from "../src/ports.ts"
import { samPath } from "../src/samPath.ts"

/**
 * Starts three servers on ports of their own and shows that automatic actions move to another
 * instance when the one that runs them dies:
 *
 * - the host (`MUFW_SYNC=host`, `MUFW_AUTO_ACTIONS=off`) carries the log and never ticks, so it only
 *   shows what the log holds;
 * - the first joiner (`MUFW_AUTO_ACTIONS=on`) is the first to claim the lease: it opens the auction
 *   and ticks it;
 * - the second joiner (`on`) takes part in the lease and waits.
 *
 * The first joiner is then killed with SIGKILL, so it releases nothing. The log must show no tick
 * while its lease is unexpired, then a tick from the second joiner after the lease timeout, and
 * the host and the second joiner must go on showing the same auction as it ticks. The host carries
 * the log, so it is never the instance that dies. Needs no running server; stops everything it starts.
 */
const HOST_PORT = 3221
const LOG_PORT = 3321
const FIRST_PORT = 3222
const SECOND_PORT = 3223
const AUCTION_ROOT = fileURLToPath(new URL("..", import.meta.url))
const LEASE_TIMEOUT_SECONDS = 15
const TAKEOVER_WITHIN = `${LEASE_TIMEOUT_SECONDS + 15} seconds` as const
const WITHIN = "30 seconds"

interface Server {
  readonly child: ChildProcess
  readonly output: Array<string>
}

const serverEnv = (port: number, autoActions: "on" | "off", sync: string) => ({
  ...process.env,
  MUFW_PORT: String(port),
  MUFW_SYNC: sync,
  MUFW_SYNC_PORT: String(LOG_PORT),
  MUFW_AUTO_ACTIONS: autoActions
})

const spawnServer = (env: NodeJS.ProcessEnv): Server => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: AUCTION_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  })
  const output: Array<string> = []
  const collect = (chunk: Buffer) => void output.push(chunk.toString())
  child.stdout?.on("data", collect)
  child.stderr?.on("data", collect)
  return { child, output }
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

/** SIGTERM, then SIGKILL if the process has not left after three seconds. */
const stopServer = ({ child }: Server) =>
  Effect.callback<void>((resume) => {
    if (exited(child)) return resume(Effect.void)
    const hardStop = setTimeout(() => child.kill("SIGKILL"), 3000)
    child.once("exit", () => {
      clearTimeout(hardStop)
      resume(Effect.void)
    })
    child.kill("SIGTERM")
  })

const accepts = (port: number) =>
  Effect.callback<void, string>((resume) => {
    const socket = connect({ port, host: "127.0.0.1" })
    socket.once("connect", () => {
      socket.destroy()
      resume(Effect.void)
    })
    socket.once("error", (error) => resume(Effect.fail(error.message)))
  })

const untilListening = (port: number) =>
  accepts(port).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }))

/** A server stopped when the script's scope closes, returned once it listens on `port`. */
const startServer = (port: number, env: NodeJS.ProcessEnv) =>
  Effect.acquireRelease(Effect.sync(() => spawnServer(env)), stopServer).pipe(Effect.tap(() => untilListening(port)))

const killHard = (server: Server) =>
  Effect.callback<void>((resume) => {
    server.child.once("exit", () => resume(Effect.void))
    server.child.kill("SIGKILL")
  })

/** One server's remote ports over their own connection, acting as the bidder that owns `session`. */
const connectTo = (port: number, session: string) => {
  const client = Rpc.layerClient.pipe(
    Layer.provide(layerAuthenticationClient(SessionToken.make(session))),
    Layer.provide(RpcClient.layerProtocolSocket()),
    Layer.provide(NodeSocket.layerWebSocket(`ws://127.0.0.1:${port}${samPath(Auction)}`)),
    Layer.provide(RpcSerialization.layerJson)
  )
  return Layer.build(Rpc.layerModelRemote.pipe(Layer.provide(client))).pipe(
    Effect.map((context) => Context.get(context, Ports.ModelPort))
  )
}

type Connection = ModelPortShape<typeof Auction>

const seen = (connection: Connection, within: `${number} seconds`, reached: (representation: Representation) => boolean) =>
  connection.representations.pipe(
    Stream.filter(reached),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.timeout(within)
  )

const remainingOn = (connection: Connection) =>
  connection.representations.pipe(Stream.runHead, Effect.map((head) => Option.getOrThrow(head).remainingSeconds))

const program = Effect.gen(function*() {
  yield* startServer(HOST_PORT, serverEnv(HOST_PORT, "off", "host")).pipe(
    Effect.tap(() => untilListening(LOG_PORT))
  )
  const log = `ws://127.0.0.1:${LOG_PORT}/eventlog`
  const first = yield* startServer(FIRST_PORT, serverEnv(FIRST_PORT, "on", log))
  const onHost = yield* connectTo(HOST_PORT, "demo-alice")
  yield* seen(onHost, WITHIN, (representation) => representation.controlState === "open")
  const afterTicks = yield* seen(onHost, WITHIN, (representation) => representation.remainingSeconds <= 56)
  yield* Console.log(`ok the first joiner holds the lease: the host, which never ticks, shows the auction ticking (${afterTicks.remainingSeconds}s left)`)

  const second = yield* startServer(SECOND_PORT, serverEnv(SECOND_PORT, "on", log))
  const onSecond = yield* connectTo(SECOND_PORT, "demo-bob")
  yield* seen(onSecond, WITHIN, (representation) => representation.remainingSeconds <= afterTicks.remainingSeconds)
  yield* Console.log("ok the second joiner holds the same auction and waits")

  const killedAt = Date.now()
  yield* killHard(first)
  yield* Effect.sleep("2 seconds")
  const atDeath = yield* remainingOn(onHost)
  yield* Effect.sleep("5 seconds")
  const whileLeased = yield* remainingOn(onHost)
  assert.equal(whileLeased, atDeath, "no instance may tick before the lease of the dead one has timed out")
  yield* Console.log(`ok the first joiner was killed (SIGKILL): five seconds later nothing has ticked (${atDeath}s left)`)

  const afterTakeover = yield* seen(onHost, TAKEOVER_WITHIN, (representation) => representation.remainingSeconds < atDeath)
  const takeoverSeconds = Math.round((Date.now() - killedAt) / 1000)
  yield* Console.log(`ok the lease timed out and the auction ticks again on the host ${takeoverSeconds}s after the kill (${afterTakeover.remainingSeconds}s left)`)

  yield* seen(onHost, WITHIN, (representation) => representation.remainingSeconds <= afterTakeover.remainingSeconds - 3)
  const onHostNow = yield* remainingOn(onHost)
  const onSecondNow = yield* remainingOn(onSecond)
  assert.ok(Math.abs(onHostNow - onSecondNow) <= 1, `the host shows ${onHostNow}s, the second joiner ${onSecondNow}s`)
  yield* Console.log(`ok the auction keeps ticking, and the host (${onHostNow}s left) and the second joiner (${onSecondNow}s left) show the same`)

  assert.match(first.output.join(""), /took the lease/)
  assert.match(second.output.join(""), /took the lease/)
  yield* Console.log("ok each joiner logged the moment it took the lease")
}).pipe(Effect.scoped, Effect.timeout("150 seconds"))

NodeRuntime.runMain(program)
