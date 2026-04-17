import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { KIMI_CLI_VERSION, USER_AGENT } from "../src/constants.ts"
import { getDeviceId, kimiHeaders } from "../src/headers.ts"

// Note: getDeviceId() reads/writes ~/.kimi/device_id. That file is shared
// with kimi-cli on purpose (AGENTS.md rule 2) and the function is
// idempotent — if the file exists we reuse it, otherwise we create it. The
// tests therefore use the real HOME: they cannot clobber anything, and
// mocking `os.homedir` for Node's built-in `os` is fragile (Bun resolves
// the import binding eagerly).

test("kimiHeaders emits exactly the 7 fingerprint keys kimi-cli sends", () => {
  const h = kimiHeaders()
  expect(Object.keys(h).sort()).toEqual(
    [
      "User-Agent",
      "X-Msh-Device-Id",
      "X-Msh-Device-Model",
      "X-Msh-Device-Name",
      "X-Msh-Os-Version",
      "X-Msh-Platform",
      "X-Msh-Version",
    ].sort(),
  )
})

test("User-Agent and X-Msh-Version track KIMI_CLI_VERSION (AGENTS.md rule 1)", () => {
  const h = kimiHeaders()
  expect(h["User-Agent"]).toBe(USER_AGENT)
  expect(h["User-Agent"]).toContain(KIMI_CLI_VERSION)
  expect(h["X-Msh-Version"]).toBe(KIMI_CLI_VERSION)
  expect(h["X-Msh-Platform"]).toBe("kimi_cli")
})

test("All header values are ASCII-only (undici rejects non-ASCII)", () => {
  for (const [k, v] of Object.entries(kimiHeaders())) {
    expect(v, `header ${k}`).toMatch(/^[\x20-\x7e]+$/)
  }
})

test("Device id is a 32-char lowercase hex string (kimi-cli UUIDv4 no-dashes format)", () => {
  expect(getDeviceId()).toMatch(/^[0-9a-f]{32}$/)
})

test("Device id is stable across calls and matches ~/.kimi/device_id on disk (AGENTS.md rule 2)", () => {
  const first = getDeviceId()
  const second = getDeviceId()
  expect(second).toBe(first)
  // Mirrors kimi-cli's path; shared by design.
  const onDisk = fs.readFileSync(path.join(os.homedir(), ".kimi", "device_id"), "utf8").trim()
  expect(onDisk).toBe(first)
})

test("Device id is also present and matches in the headers map", () => {
  const h = kimiHeaders()
  expect(h["X-Msh-Device-Id"]).toBe(getDeviceId())
})
