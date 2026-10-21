import { runPage } from "./app.ts"
import { serverModel } from "./placements/serverModel.ts"

runPage(serverModel(), "model:server,actions:client")
