import { runPage } from "./app.ts"
import { browserOnly } from "./placements/browserOnly.ts"

runPage(browserOnly(), "model:client,actions:client")
