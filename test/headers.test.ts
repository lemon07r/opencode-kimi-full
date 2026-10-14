import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { KIMI_CODE_CLI_VERSION, USER_AGENT } from "../src/constants.ts"
import { asciiHeaderValue, getDeviceId, kimiCodeHome, kimiDeviceModel, kimiHeaders } from "../src/headers.ts"

// Note: getDeviceId() reads/writes <KIMI_CODE_HOME>/device_id (default
// ~/.kimi-code/device_id), respecting the KIMI_CODE_HOME env override. That
// file is shared with kimi-code-cli on purpose (AGENTS.md rule 2) and the
// function is idempotent — if the file exists we reuse it, otherwise we create
// it. The tests therefore use the real HOME: they cannot clobber anything, and
// mocking `os.homedir` for Node's built-in `os` is fragile (Bun resolves the
// import binding eagerly).

test("kimiHeaders emits exactly the 7 fingerprint keys kimi-code-cli sends", () => {
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

test("User-Agent and X-Msh-Version track KIMI_CODE_CLI_VERSION (AGENTS.md rule 1)", () => {
  const h = kimiHeaders()
  expect(h["User-Agent"]).toBe(USER_AGENT)
  expect(h["User-Agent"]).toContain(KIMI_CODE_CLI_VERSION)
  expect(h["X-Msh-Version"]).toBe(KIMI_CODE_CLI_VERSION)
  expect(h["X-Msh-Platform"]).toBe("kimi_code_cli")
})

test("All header values are ASCII-only (undici rejects non-ASCII)", () => {
  for (const [k, v] of Object.entries(kimiHeaders())) {
    expect(v, `header ${k}`).toMatch(/^[\x20-\x7e]+$/)
  }
})

test("asciiHeaderValue strips non-ASCII bytes like kimi-code-cli and falls back when empty", () => {
  expect(asciiHeaderValue(" hoste ")).toBe("hoste")
  expect(asciiHeaderValue("hést")).toBe("hst")
  expect(asciiHeaderValue("你好")).toBe("unknown")
})

test("Device id is a standard UUIDv4 string (kimi-code-cli format with dashes)", () => {
  expect(getDeviceId()).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
})

test("Device id is stable across calls and matches <KIMI_CODE_HOME>/device_id on disk (AGENTS.md rule 2)", () => {
  const first = getDeviceId()
  const second = getDeviceId()
  expect(second).toBe(first)
  // Mirrors kimi-code-cli's path; shared by design.
  const onDisk = fs.readFileSync(path.join(kimiCodeHome(), "device_id"), "utf8").trim()
  expect(onDisk).toBe(first)
})

test("Device id is also present and matches in the headers map", () => {
  const h = kimiHeaders()
  expect(h["X-Msh-Device-Id"]).toBe(getDeviceId())
})

// Regression guard: prior to v1.0.3 we were sending `X-Msh-Device-Model =
// <arch>` and `X-Msh-Os-Version = <type release>`. That didn't match
// kimi-code-cli and caused Moonshot to 403 every request from this plugin
// with "access_terminated_error". Keep this tied to the helper so Linux,
// macOS, and Windows all stay on the same parity path.
test("X-Msh-Device-Model matches the kimi-code-cli parity helper", () => {
  const h = kimiHeaders()
  expect(h["X-Msh-Device-Model"]).toBe(asciiHeaderValue(kimiDeviceModel()))
})

test("kimiDeviceModel mirrors kimi-code-cli Darwin and Windows special cases", () => {
  expect(kimiDeviceModel({ system: "Darwin", release: "23.6.0", arch: "arm64", macVersion: "15.4.1" })).toBe(
    "macOS 15.4.1 arm64",
  )
  expect(kimiDeviceModel({ system: "Windows_NT", release: "10.0.26100", arch: "x64" })).toBe("Windows 10.0.26100 x64")
  expect(kimiDeviceModel({ system: "Windows_NT", release: "10.0.19045", arch: "x64" })).toBe("Windows 10.0.19045 x64")
  expect(kimiDeviceModel({ system: "Linux", release: "6.8.0", arch: "x86_64" })).toBe("Linux 6.8.0 x86_64")
})

test("X-Msh-Os-Version matches os.release()", () => {
  const h = kimiHeaders()
  expect(h["X-Msh-Os-Version"]).toBe(os.release())
})

test("kimiCodeHome defaults to ~/.kimi-code", () => {
  const original = process.env.KIMI_CODE_HOME
  delete process.env.KIMI_CODE_HOME
  try {
    expect(kimiCodeHome()).toBe(path.join(os.homedir(), ".kimi-code"))
  } finally {
    if (original !== undefined) process.env.KIMI_CODE_HOME = original
  }
})

test("kimiCodeHome respects KIMI_CODE_HOME and expands leading ~", () => {
  const original = process.env.KIMI_CODE_HOME
  process.env.KIMI_CODE_HOME = "~/custom-kimi-code"
  try {
    expect(kimiCodeHome()).toBe(path.join(os.homedir(), "custom-kimi-code"))
  } finally {
    if (original !== undefined) process.env.KIMI_CODE_HOME = original
    else delete process.env.KIMI_CODE_HOME
  }
})
