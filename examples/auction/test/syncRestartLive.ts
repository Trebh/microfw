import assert from "node:assert/strict"
import { NodeRuntime, NodeSocket } from "@effect/platform-node"
import { Console, Context, Effect, Exit, Fiber, Layer, Option, Schedule, Scope, Stream } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { type ChildProcess, spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { layerAuthenticationClient } from "../src/authentication.ts"
import { Auction } from "../src/auction/Auction.ts"
import { Amount, SessionToken } from "../src/domain/Values.ts"
import { Ports, Rpc } from "../src/ports.ts"
import { samPath } from "../src/samPath.ts"

/**
 * Starts a host (`MUFW_SYNC=host` with a store) and a joiner (with a store of its own) on ports of
 * its own, and shows what a restart does:
 *
 * 1. the host restarts over its store: the log, its id and the model survive, and the joiner,
 *    which was never restarted, keeps converging with it in both directions;
 * 2. the joiner restarts over its store: it holds the model of the log as its initial record and
 *    reads only the entries after its checkpoint, not the whole log;
 * 3. the host restarts over a store that is empty, so a new log: the joiner finds it is not the
 *    log it joined and stops with `SyncLogMismatch`.
 *
 * The servers run `src/server.ts` with `MUFW_AUTO_ACTIONS=off`, so only what this script does moves
 * the model. Needs no running server; stops everything it starts.
 */
const HOST_PORT = 3211
const LOG_PORT = 3311
const JOINER_PORT = 3212
const AUCTION_ROOT = fileURLToPath(new URL("..", import.meta.url))
const TIMEOUT = "20 seconds"

interface Server {
  readonly child: ChildProcess
  readonly output: Array<string>
}

const serverEnv = (port: number, sync: string, store: string | undefined) => ({
  ...process.env,
  MUFW_PORT: String(port),
  MUFW_SYNC: sync,
  MUFW_SYNC_PORT: String(LOG_PORT),
  MUFW_AUTO_ACTIONS: "off",
  ...(store === undefined ? {} : { MUFW_STORE: store })
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
    const force = setTimeout(() => child.kill("SIGKILL"), 3_000)
    child.once("exit", () => {
      clearTimeout(force)
      resume(Effect.void)
    })
    child.kill("SIGTERM")
  })

const accepts = (port: number) =>
  Effect.callback<void, string>((resume) => {
    const socket = connect(port, "127.0.0.1")
    socket.once("connect", () => socket.end(() => resume(Effect.void)))
    socket.once("error", () => resume(Effect.fail(`nothing listens on ${port}`)))
  })

const untilListening = (port: number) =>
  accepts(port).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }))

/** A server stopped when `scope` closes, returned once it listens on `port`. */
const startServer = (scope: Scope.Scope, port: number, env: NodeJS.ProcessEnv) =>
  Effect.acquireRelease(Effect.sync(() => spawnServer(env)), stopServer).pipe(
    Effect.tap(() => untilListening(port)),
    Scope.provide(scope)
  )

/** A scope of its own, so that a server can be stopped and started again without ending the script. */
const ownScope = Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))

const startHost = (scope: Scope.Scope, store: string | undefined) =>
  startServer(scope, HOST_PORT, serverEnv(HOST_PORT, "host", store)).pipe(Effect.tap(() => untilListening(LOG_PORT)))

/** A joiner of the host's log, which `store` (when given) lets resume from its checkpoint. */
const startJoiner = (scope: Scope.Scope, store: string | undefined) =>
  startServer(scope, JOINER_PORT, serverEnv(JOINER_PORT, `ws://127.0.0.1:${LOG_PORT}/eventlog`, store))

/** One server's remote ports over their own connection, acting as the bidder that owns `session`. */
const connectTo = (port: number, session: string) => {
  const client = Rpc.layerClient.pipe(
    Layer.provide(layerAuthenticationClient(SessionToken.make(session))),
    Layer.provide(RpcClient.layerProtocolSocket()),
    Layer.provide(NodeSocket.layerWebSocket(`ws://127.0.0.1:${port}${samPath(Auction)}`)),
    Layer.provide(RpcSerialization.layerJson)
  )
  return Layer.build(
    Layer.mergeAll(Rpc.layerModelRemote, Rpc.layerHistoryRemote, Rpc.layerIntentPortRemote).pipe(
      Layer.provide(client)
    )
  ).pipe(
    Effect.map((context) => ({
      model: Context.get(context, Ports.ModelPort),
      history: Context.get(context, Ports.HistoryPort),
      intents: Context.get(context, Ports.IntentPort)
    }))
  )
}

type Connection = Effect.Success<ReturnType<typeof connectTo>>

const bidders = (connection: Connection, count: number) =>
  connection.model.representations.pipe(
    Stream.filter((representation) => representation.bids.length >= count),
    Stream.runHead,
    Effect.map((head) => Option.getOrThrow(head).bids.map((bid) => `${bid.bidder}:${bid.amount}`)),
    Effect.timeout(TIMEOUT)
  )

/** The records the server's history holds a second after the connection is made: the initial one and any later one. */
const recordsHeld = (connection: Connection) =>
  Effect.gen(function*() {
    const seen: Array<{ readonly kind: string; readonly bids: number }> = []
    const reading = yield* Effect.forkScoped(
      Stream.runForEach(connection.history.records, (record) =>
        Effect.sync(() => void seen.push({ kind: record.kind, bids: record.model.bids.length })))
    )
    yield* Effect.sleep("1 second")
    yield* Fiber.interrupt(reading)
    return seen
  })

const bid = (connection: Connection, amount: number) =>
  connection.intents.dispatch({ _tag: "PlaceBid", amount: Amount.make(amount) })

const exitWithin = (server: Server, within: number) =>
  Effect.callback<number | null, string>((resume) => {
    if (exited(server.child)) return resume(Effect.succeed(server.child.exitCode))
    const timer = setTimeout(() => resume(Effect.fail(`process still running after ${within} ms`)), within)
    server.child.once("exit", (code) => {
      clearTimeout(timer)
      resume(Effect.succeed(code))
    })
  })

const temporaryDirectory = (name: string) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), `mufw-${name}-`))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )

const program = Effect.gen(function*() {
  const hostStore = yield* temporaryDirectory("host")
  const joinerStore = yield* temporaryDirectory("joiner")
  const hostScope = yield* ownScope
  const joinerScope = yield* ownScope

  yield* startHost(hostScope, hostStore)
  yield* startJoiner(joinerScope, joinerStore)
  const onJoiner = yield* connectTo(JOINER_PORT, "demo-bob")
  const onHost = yield* connectTo(HOST_PORT, "demo-alice")
  yield* onHost.intents.dispatch({ _tag: "Open" })
  yield* onJoiner.model.representations.pipe(
    Stream.filter((representation) => representation.controlState === "open"),
    Stream.runHead,
    Effect.timeout(TIMEOUT)
  )
  yield* bid(onHost, 5)
  assert.deepEqual(yield* bidders(onJoiner, 1), ["alice:5"])
  yield* Console.log("ok before any restart a bid on the host is on the joiner")

  yield* Scope.close(hostScope, Exit.void)
  yield* Console.log("host stopped")
  const restartedHostScope = yield* ownScope
  yield* startHost(restartedHostScope, hostStore)
  yield* Console.log("host started again over its store")
  const afterRestart = yield* connectTo(HOST_PORT, "demo-alice")
  assert.deepEqual(yield* bidders(afterRestart, 1), ["alice:5"])
  yield* Console.log("ok the restarted host holds the model: its log and checkpoint survived")
  yield* bid(afterRestart, 10)
  assert.deepEqual(yield* bidders(onJoiner, 2), ["alice:5", "alice:10"])
  yield* Console.log("ok a bid on the restarted host reaches the joiner that was never restarted")
  yield* bid(onJoiner, 15)
  assert.deepEqual(yield* bidders(afterRestart, 3), ["alice:5", "alice:10", "bob:15"])
  yield* Console.log("ok a bid on the joiner reaches the restarted host")

  yield* Scope.close(joinerScope, Exit.void)
  const restartedJoinerScope = yield* ownScope
  const restartedJoiner = yield* startJoiner(restartedJoinerScope, joinerStore)
  const joinerAgain = yield* connectTo(JOINER_PORT, "demo-bob")
  assert.deepEqual(yield* bidders(joinerAgain, 3), ["alice:5", "alice:10", "bob:15"])
  assert.deepEqual(yield* recordsHeld(joinerAgain), [{ kind: "init", bids: 3 }])
  yield* Console.log(
    "ok the restarted joiner starts from its checkpoint: its only record is the initial one, holding the 3 bids; no entry of the log was replayed"
  )

  yield* Scope.close(restartedHostScope, Exit.void)
  yield* Console.log("host stopped")
  const newLogScope = yield* ownScope
  yield* startHost(newLogScope, yield* temporaryDirectory("empty"))
  yield* Console.log("host started over an empty store: a new log")
  const code = yield* exitWithin(restartedJoiner, 30_000)
  const output = restartedJoiner.output.join("")
  assert.notEqual(code, 0)
  assert.match(output, /sync log replaced, this instance stopped applying/)
  assert.match(output, /SyncLogMismatch/)
  yield* Console.log(`ok the joiner found a log that is not the one it joined and stopped (exit code ${code})`)
}).pipe(Effect.scoped, Effect.timeout("120 seconds"))

NodeRuntime.runMain(program)
