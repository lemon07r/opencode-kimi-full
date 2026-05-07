import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "bun:test"
import { ensureFreshStoredAuth } from "../src/auth-refresh.ts"
import { PROVIDER_ID } from "../src/constants.ts"
import { installFetchMock } from "./_util/fetchMock.ts"

let mock: ReturnType<typeof installFetchMock> | undefined
let root: string | undefined
let previousXdgDataHome: string | undefined

afterEach(async () => {
  mock?.restore()
  mock = undefined
  if (root) await fs.rm(root, { recursive: true, force: true })
  root = undefined
  if (previousXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME
  } else {
    process.env.XDG_DATA_HOME = previousXdgDataHome
  }
  previousXdgDataHome = undefined
})

function authStorePath(base: string) {
  return path.join(base, "opencode", "auth.json")
}

function refreshLockPath(base: string) {
  return `${authStorePath(base)}.${PROVIDER_ID}.refresh.lock`
}

async function writeAuthStore(base: string, entry: unknown) {
  await fs.mkdir(path.dirname(authStorePath(base)), { recursive: true })
  await fs.writeFile(authStorePath(base), JSON.stringify({ [PROVIDER_ID]: entry }), "utf8")
}

test("ensureFreshStoredAuth refreshes expiring auth and persists it", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-kimi-auth-refresh-"))
  previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root
  await writeAuthStore(root, {
    type: "oauth",
    access: "stale",
    refresh: "refresh-1",
    expires: Date.now() - 1_000,
  })

  mock = installFetchMock(() => ({
    body: {
      access_token: "fresh",
      refresh_token: "refresh-2",
      token_type: "Bearer",
      expires_in: 900,
    },
  }))

  const auth = await ensureFreshStoredAuth()
  expect(auth.access).toBe("fresh")
  expect(auth.refresh).toBe("refresh-2")

  const stored = JSON.parse(await fs.readFile(authStorePath(root), "utf8")) as Record<string, any>
  expect(stored[PROVIDER_ID].access).toBe("fresh")
  expect(stored[PROVIDER_ID].refresh).toBe("refresh-2")
  expect(mock.calls).toHaveLength(1)
})

test("ensureFreshStoredAuth removes stale refresh locks", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-kimi-auth-refresh-"))
  previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root
  await writeAuthStore(root, {
    type: "oauth",
    access: "stale",
    refresh: "refresh-1",
    expires: Date.now() - 1_000,
  })

  const lockDir = refreshLockPath(root)
  await fs.mkdir(lockDir)
  await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ token: "dead" }), "utf8")
  const stale = new Date(Date.now() - 180_000)
  await fs.utimes(path.join(lockDir, "owner.json"), stale, stale)
  await fs.utimes(lockDir, stale, stale)

  mock = installFetchMock(() => ({
    body: {
      access_token: "fresh",
      refresh_token: "refresh-2",
      token_type: "Bearer",
      expires_in: 900,
    },
  }))

  const auth = await ensureFreshStoredAuth()
  expect(auth.access).toBe("fresh")
  expect(
    await fs
      .access(lockDir)
      .then(() => true)
      .catch(() => false),
  ).toBe(false)
  expect(mock.calls).toHaveLength(1)
})

test("ensureFreshStoredAuth does not fail when cleanup cannot verify lock ownership", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-kimi-auth-refresh-"))
  previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root
  await writeAuthStore(root, {
    type: "oauth",
    access: "stale",
    refresh: "refresh-1",
    expires: Date.now() - 1_000,
  })

  mock = installFetchMock(async () => {
    await fs.writeFile(path.join(refreshLockPath(root!), "owner.json"), "{", "utf8")
    return {
      body: {
        access_token: "fresh",
        refresh_token: "refresh-2",
        token_type: "Bearer",
        expires_in: 900,
      },
    }
  })

  const auth = await ensureFreshStoredAuth()
  expect(auth.access).toBe("fresh")
  expect(mock.calls).toHaveLength(1)
})
