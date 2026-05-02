import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PROVIDER_ID } from "./constants.ts"

export type OAuthAuth = {
  type: "oauth"
  refresh: string
  access: string
  expires: number
}

export type AuthStoreEntry = {
  file: string
  parsed: Record<string, unknown>
  entry: OAuthAuth
}

export function isOAuthAuth(value: unknown): value is OAuthAuth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const auth = value as Partial<OAuthAuth>
  return (
    auth.type === "oauth" &&
    typeof auth.access === "string" &&
    typeof auth.refresh === "string" &&
    typeof auth.expires === "number"
  )
}

export function authStoreCandidates() {
  const home = os.homedir()
  if (process.env.XDG_DATA_HOME) {
    return [path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json")]
  }
  const candidates = new Set<string>()
  candidates.add(path.join(home, ".local", "share", "opencode", "auth.json"))
  if (process.platform === "darwin") {
    candidates.add(path.join(home, "Library", "Application Support", "opencode", "auth.json"))
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    candidates.add(path.join(local, "opencode", "auth.json"))
    if (process.env.APPDATA) {
      candidates.add(path.join(process.env.APPDATA, "opencode", "auth.json"))
    }
  }
  return [...candidates]
}

export async function resolveAuthStorePath() {
  const candidates = authStoreCandidates()
  for (const file of candidates) {
    try {
      await fs.access(file)
      return file
    } catch {}
  }
  return candidates[0]!
}

export async function readAuthStore() {
  for (const file of authStoreCandidates()) {
    try {
      return { file, parsed: JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown> }
    } catch {}
  }
  return { file: authStoreCandidates()[0]!, parsed: {} as Record<string, unknown> }
}

export async function readAuthStoreEntry(): Promise<AuthStoreEntry | undefined> {
  for (const file of authStoreCandidates()) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
      const entry = parsed[PROVIDER_ID] ?? parsed[`${PROVIDER_ID}/`]
      if (isOAuthAuth(entry)) return { file, parsed, entry }
    } catch {}
  }
  return
}

export async function readAuth() {
  return (await readAuthStoreEntry())?.entry
}

export async function writeAuthStoreEntry(file: string, parsed: Record<string, unknown>, auth: OAuthAuth) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify({ ...parsed, [PROVIDER_ID]: auth }, null, 2)}\n`)
}
