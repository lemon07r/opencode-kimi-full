import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { KIMI_CLI_VERSION, USER_AGENT } from "./constants.ts"

// kimi-cli persists its device id at `~/.kimi/device_id` as a plain UUIDv4
// hex string (no dashes). We intentionally share the same path so users who
// also run the real kimi CLI keep a single stable fingerprint. See
// research/kimi-cli/src/kimi_cli/auth/oauth.py (get_device_id).
const DEVICE_ID_DIR = path.join(os.homedir(), ".kimi")
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
  const id = crypto.randomUUID().replace(/-/g, "")
  fs.writeFileSync(DEVICE_ID_PATH, id, { mode: 0o600 })
  return id
}

// Non-ASCII characters in HTTP headers will be rejected by Node's undici
// fetch (`TypeError: Invalid character in header content`). kimi-cli does the
// same sanitization in oauth._ascii_header_value.
function ascii(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?")
}

/**
 * Builds the 7 X-Msh-* / UA headers kimi-cli sends on every request.
 *
 * Values mirror research/kimi-cli/src/kimi_cli/auth/oauth.py → _common_headers
 * and _device_model. Deviations cause Moonshot's backend to 403 with
 * "access_terminated_error: Kimi For Coding is currently only available for
 * Coding Agents". Node equivalents:
 *   - platform.system()  → os.type()     ("Linux"/"Darwin"/"Windows_NT")
 *   - platform.release() → os.release()
 *   - platform.machine() → os.machine?.() (Node 20+ "x86_64"; NOT os.arch() which says "x64")
 *   - platform.version() → os.version()  (kernel build string on Linux)
 */
export function kimiHeaders(): Record<string, string> {
  const machine = os.machine?.() || os.arch()
  return {
    "User-Agent": USER_AGENT,
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": KIMI_CLI_VERSION,
    "X-Msh-Device-Name": ascii(os.hostname() || "unknown"),
    "X-Msh-Device-Model": ascii(`${os.type()} ${os.release()} ${machine}`),
    "X-Msh-Device-Id": getDeviceId(),
    "X-Msh-Os-Version": ascii(os.version?.() || `${os.type()} ${os.release()}`),
  }
}
