import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { authStoreCandidates } from "./auth-store.ts"
import type { KimiModelInfo } from "./oauth.ts"

// Last-known-good `/models` response, persisted next to opencode's auth.json.
// Purpose: the model list must survive conditions where the server cannot
// serve it right now — offline start, token refresh failure, or an HTTP 402
// "membership benefits" rejection. The server is still queried first on every
// startup and on every token refresh; this cache is strictly a fallback so a
// lapsed subscription does not empty the picker.

const CACHE_FILENAME = "kimi-for-coding-oauth.models.json"

function cacheFilePath() {
  return path.join(path.dirname(authStoreCandidates()[0]!), CACHE_FILENAME)
}

export async function readDiscoveryCache(): Promise<KimiModelInfo[] | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFilePath(), "utf8")) as { models?: unknown }
    if (!Array.isArray(parsed.models)) return undefined
    const models = parsed.models.filter(
      (m): m is KimiModelInfo => Boolean(m) && typeof (m as KimiModelInfo).id === "string",
    )
    return models.length ? models : undefined
  } catch {
    return undefined
  }
}

export async function writeDiscoveryCache(models: KimiModelInfo[]): Promise<void> {
  const file = cacheFilePath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), models }, null, 2)}\n`)
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}
