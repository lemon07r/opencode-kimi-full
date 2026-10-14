import { ensureFreshStoredAuth } from "../src/auth-refresh.ts"
import { listModels } from "../src/oauth.ts"

const auth = await ensureFreshStoredAuth()
console.log("token expires at:", new Date(auth.expires).toISOString())
const models = await listModels(auth.access)
console.log(JSON.stringify(models, null, 2))
