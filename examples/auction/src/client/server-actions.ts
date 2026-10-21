import { runPage } from "./app.ts"
import { serverActions } from "./placements/serverActions.ts"

runPage(serverActions(), "model:client,actions:server")
