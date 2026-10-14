import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import childProcess from "node:child_process"
import { KIMI_CODE_CLI_VERSION, USER_AGENT } from "./constants.ts"

export function kimiCodeHome(): string {
  const override = process.env.KIMI_CODE_HOME
  if (override !== undefined && override.length > 0) {
    // Shells expand ~, but env vars set outside a shell do not. Match the
    // intuitive behavior so KIMI_CODE_HOME=~/.kimi-code works as expected.
    if (override.startsWith("~")) {
      return path.join(os.homedir(), override.slice(1))
    }
    return override
  }
  return path.join(os.homedir(), ".kimi-code")
}

// kimi-code-cli persists its device id at `<KIMI_CODE_HOME>/device_id` as a
// plain UUIDv4 string (with dashes). We intentionally share the same path so
// users who also run the official kimi-code-cli keep a single stable fingerprint.
const DEVICE_ID_DIR = kimiCodeHome()
const DEVICE_ID_PATH = path.join(DEVICE_ID_DIR, "device_id")

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export function getDeviceId(): string {
  ensureDir(DEVICE_ID_DIR)
  if (fs.existsSync(DEVICE_ID_PATH)) {
    const existing = fs.readFileSync(DEVICE_ID_PATH, "utf8").trim()
    if (existing) return existing
  }
  const id = crypto.randomUUID()
  fs.writeFileSync(DEVICE_ID_PATH, id, { mode: 0o600 })
  return id
}

// Non-ASCII characters in HTTP headers will be rejected by Node's undici
// fetch (`TypeError: Invalid character in header content`). kimi-code-cli strips
// non-ASCII bytes; we do the same while also dropping control characters to
// stay within Node's header rules.
export function asciiHeaderValue(value: string, fallback = "unknown"): string {
  const sanitized = value.replace(/[^\x20-\x7e]/g, "").trim()
  return sanitized || fallback
}

let cachedMacVersion: string | undefined

function macProductVersion(): string | undefined {
  if (process.platform !== "darwin") return undefined
  if (cachedMacVersion !== undefined) return cachedMacVersion || undefined
  try {
    cachedMacVersion = childProcess.execFileSync("sw_vers", ["-productVersion"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    cachedMacVersion = ""
  }
  return cachedMacVersion || undefined
}

/**
 * Mirrors kimi-code-cli's device-model logic.
 *
 * Source: https://github.com/MoonshotAI/kimi-code/packages/oauth/src/identity.ts
 *
 * Uses `os.arch()` for the machine part on all platforms (Node returns values
 * like "x64" / "arm64"), and `os.release()` for the Windows version string.
 */
export function kimiDeviceModel(input?: {
  system?: string
  release?: string
  arch?: string
  macVersion?: string
}) {
  const system = input?.system ?? os.type()
  const release = input?.release ?? os.release()
  const arch = input?.arch ?? os.arch()

  if (system === "Darwin") {
    const version = input?.macVersion ?? macProductVersion() ?? release
    if (version && arch) return `macOS ${version} ${arch}`
    if (version) return `macOS ${version}`
    return `macOS ${arch}`.trim()
  }

  if (system === "Windows_NT") {
    if (release && arch) return `Windows ${release} ${arch}`
    if (release) return `Windows ${release}`
    return `Windows ${arch}`.trim()
  }

  if (system) {
    if (release && arch) return `${system} ${release} ${arch}`
    if (release) return `${system} ${release}`
    return `${system} ${arch}`.trim()
  }

  return "Unknown"
}

/**
 * Builds the 7 X-Msh-* / UA headers kimi-code-cli sends on every request.
 *
 * Source: https://github.com/MoonshotAI/kimi-code/packages/oauth/src/identity.ts
 *
 * Deviations cause Moonshot's backend to 403 with
 * "access_terminated_error: Kimi For Coding is currently only available for
 * Coding Agents". Node equivalents:
 *   - platform.system()  → os.type()     ("Linux"/"Darwin"/"Windows_NT")
 *   - platform.release() → os.release()
 *   - platform.machine() → os.arch()     (Node "x64"/"arm64")
 */
export function kimiHeaders(): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    "X-Msh-Platform": "kimi_code_cli",
    "X-Msh-Version": KIMI_CODE_CLI_VERSION,
    "X-Msh-Device-Name": asciiHeaderValue(os.hostname() || "unknown"),
    "X-Msh-Device-Model": asciiHeaderValue(kimiDeviceModel()),
    "X-Msh-Device-Id": getDeviceId(),
    "X-Msh-Os-Version": asciiHeaderValue(os.release()),
  }
}
