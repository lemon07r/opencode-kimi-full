import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { PROVIDER_ID, REFRESH_SAFETY_WINDOW_MS } from "./constants.ts"
import {
  readAuth,
  readAuthStoreEntry,
  resolveAuthStorePath,
  writeAuthStoreEntry,
  type OAuthAuth,
} from "./auth-store.ts"
import { refreshToken } from "./oauth.ts"

const REFRESH_LOCK_WAIT_MS = 15_000
const REFRESH_LOCK_POLL_MS = 100
const REFRESH_LOCK_STALE_MS = 120_000
const REFRESH_LOCK_HEARTBEAT_MS = 30_000
const REFRESH_LOCK_OWNER_FILE = "owner.json"

type RefreshOptions = {
  force?: boolean
  readLatest?: () => Promise<OAuthAuth | undefined>
  persist: (auth: OAuthAuth) => Promise<void>
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isNodeError(error: unknown, code: string) {
  return (error as NodeJS.ErrnoException).code === code
}

function sameAuth(left: OAuthAuth, right: OAuthAuth) {
  return left.access === right.access && left.refresh === right.refresh && left.expires === right.expires
}

function withInvalidGrantHint(error: unknown) {
  if (!(error instanceof Error) || !/invalid_grant/.test(error.message)) return error
  const next = new Error(
    `${error.message}. The token may have been rotated or revoked in another opencode session — run \`opencode auth login ${PROVIDER_ID}\` again if it does not self-heal.`,
  ) as Error & { code?: string; status?: number }
  next.code = (error as Error & { code?: string }).code
  next.status = (error as Error & { status?: number }).status
  return next
}

export function isAuthExpiring(auth: OAuthAuth) {
  return auth.expires - Date.now() < REFRESH_SAFETY_WINDOW_MS
}

function lockOwner(token: string) {
  return {
    token,
    pid: process.pid,
    updatedAt: Date.now(),
  }
}

async function writeLockOwner(ownerFile: string, token: string) {
  const tmpOwnerFile = `${ownerFile}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(tmpOwnerFile, JSON.stringify(lockOwner(token)), "utf8")
    await fs.rename(tmpOwnerFile, ownerFile)
  } catch (error) {
    await fs.rm(tmpOwnerFile, { force: true }).catch(() => undefined)
    throw error
  }
}

async function ownsLock(ownerFile: string, token: string) {
  try {
    const data = JSON.parse(await fs.readFile(ownerFile, "utf8")) as { token?: unknown }
    return data.token === token
  } catch (error) {
    if (isNodeError(error, "ENOENT") || error instanceof SyntaxError) return false
    throw error
  }
}

async function removeStaleLock(lockDir: string, ownerFile: string) {
  const stat = await fs.stat(ownerFile).catch(async (error) => {
    if (!isNodeError(error, "ENOENT")) throw error
    return fs.stat(lockDir).catch((lockError) => {
      if (isNodeError(lockError, "ENOENT")) return
      throw lockError
    })
  })
  if (!stat) return true
  if (Date.now() - stat.mtimeMs <= REFRESH_LOCK_STALE_MS) return false

  const staleDir = `${lockDir}.stale.${process.pid}.${Date.now()}.${crypto.randomUUID()}`
  try {
    await fs.rename(lockDir, staleDir)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true
    throw error
  }
  await fs.rm(staleDir, { recursive: true, force: true })
  return true
}

async function withRefreshLock<T>(work: () => Promise<T>) {
  const authFile = await resolveAuthStorePath()
  const lockDir = `${authFile}.${PROVIDER_ID}.refresh.lock`
  const ownerFile = path.join(lockDir, REFRESH_LOCK_OWNER_FILE)
  const ownerToken = crypto.randomUUID()
  await fs.mkdir(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS

  while (true) {
    try {
      await fs.mkdir(lockDir)
      await writeLockOwner(ownerFile, ownerToken).catch(async (error) => {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
        throw error
      })
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST") throw error
      if (await removeStaleLock(lockDir, ownerFile)) continue
      if (Date.now() >= deadline) {
        throw new Error("kimi oauth: timed out waiting for the auth refresh lock")
      }
      await sleep(REFRESH_LOCK_POLL_MS)
    }
  }

  const heartbeat = setInterval(() => {
    writeLockOwner(ownerFile, ownerToken).catch(() => undefined)
  }, REFRESH_LOCK_HEARTBEAT_MS)
  heartbeat.unref?.()

  try {
    return await work()
  } finally {
    clearInterval(heartbeat)
    await ownsLock(ownerFile, ownerToken)
      .then((owned) => (owned ? fs.rm(lockDir, { recursive: true, force: true }) : undefined))
      .catch(() => undefined)
  }
}

export async function refreshAuthWithLock(auth: OAuthAuth, options: RefreshOptions) {
  const force = options.force ?? false
  return withRefreshLock(async () => {
    const latest = await options.readLatest?.()
    const current = latest ?? auth
    if (latest && !sameAuth(latest, auth) && !force && !isAuthExpiring(latest)) return latest
    if (!force && !isAuthExpiring(current)) return current

    try {
      const tokens = await refreshToken(current.refresh)
      const next: OAuthAuth = {
        type: "oauth",
        refresh: tokens.refresh_token,
        access: tokens.access_token,
        expires: Date.now() + tokens.expires_in * 1000,
      }
      await options.persist(next)
      return next
    } catch (error) {
      const newest = await options.readLatest?.()
      if (newest && !sameAuth(newest, current)) return newest
      throw withInvalidGrantHint(error)
    }
  })
}

export async function ensureFreshStoredAuth() {
  const store = await readAuthStoreEntry()
  if (!store) {
    throw new Error(`Kimi is not authenticated. Run \`opencode auth login ${PROVIDER_ID}\` first.`)
  }
  if (!isAuthExpiring(store.entry)) return store.entry

  return refreshAuthWithLock(store.entry, {
    readLatest: readAuth,
    persist: async (auth) => {
      const latestStore = await readAuthStoreEntry()
      await writeAuthStoreEntry(latestStore?.file ?? store.file, latestStore?.parsed ?? store.parsed, auth)
    },
  })
}
