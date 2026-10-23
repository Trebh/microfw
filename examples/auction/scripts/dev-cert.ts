import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"

class MkcertFailure extends Schema.TaggedError<MkcertFailure>()("MkcertFailure", {
  message: Schema.String
}) {}

const DIRECTORY = fileURLToPath(new URL("../.certs", import.meta.url))
const CERT = `${DIRECTORY}/localhost.pem`
const KEY = `${DIRECTORY}/localhost-key.pem`

const mkcert = Effect.callback<void, MkcertFailure>((resume) => {
  const fail = (message: string) => resume(Effect.fail(new MkcertFailure({ message })))
  const child = spawn("mkcert", ["-cert-file", CERT, "-key-file", KEY, "localhost", "127.0.0.1", "::1"], { stdio: "inherit" })
  child.once("error", (error) =>
    fail(
      "code" in error && error.code === "ENOENT"
        ? "mkcert is not installed: `brew install mkcert` (macOS), or see https://github.com/FiloSottile/mkcert#installation"
        : `mkcert failed: ${error.message}`
    ))
  child.once("exit", (code) => (code === 0 ? resume(Effect.void) : fail(`mkcert exited with ${code}`)))
  return Effect.sync(() => void child.kill())
})

/**
 * A certificate for `localhost`, `127.0.0.1` and `::1` signed by mkcert's local authority, written
 * to `.certs/` (ignored by git): the private key stays on this machine. A browser trusts it once
 * the authority is in the system store, which `mkcert -install` does and this script does not,
 * since it asks for the administrator's password.
 */
const program = Effect.gen(function*() {
  yield* Effect.promise(() => mkdir(DIRECTORY, { recursive: true }))
  yield* mkcert
  yield* Console.log(`wrote ${CERT} and ${KEY}`)
  yield* Console.log("once per machine, so that browsers trust it: mkcert -install (then restart the browser)")
  yield* Console.log(`MUFW_TLS_CERT=${CERT} MUFW_TLS_KEY=${KEY} pnpm dev:server`)
})

NodeRuntime.runMain(program)
