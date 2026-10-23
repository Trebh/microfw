import { Layer } from "effect"
import { runPage } from "./app.ts"
import { pageLabels } from "./labels.ts"
import { parseIdentity } from "./placement.ts"
import { browserOnly } from "./placements/browserOnly.ts"

const identity = parseIdentity(location.search)

runPage(browserOnly(identity.bidder), pageLabels["browser-only"](location.search), Layer.empty)
