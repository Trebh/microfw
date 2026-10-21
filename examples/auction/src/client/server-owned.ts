import { runPage } from "./app.ts"
import { serverOwned } from "./placements/serverOwned.ts"

runPage(serverOwned(), "model:server,actions:server")
