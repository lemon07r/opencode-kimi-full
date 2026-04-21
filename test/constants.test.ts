import { test, expect } from "bun:test"
import * as C from "../src/constants.ts"

// These values form the "identity" of the plugin on the wire. Typos silently
// send requests down the wrong auth / backend path or collide with models.dev
// (PROVIDER_ID). See AGENTS.md "Contracts to keep intact".

test("KIMI_CLI_VERSION is a non-empty semver", () => {
  expect(C.KIMI_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
})

test("USER_AGENT embeds KIMI_CLI_VERSION", () => {
  // Must be `KimiCLI/<version>` verbatim — Moonshot's backend 403s on any
  // other UA prefix ("access_terminated_error"). See upstream
  // research/kimi-cli/src/kimi_cli/constant.py → get_user_agent.
  expect(C.USER_AGENT).toBe(`KimiCLI/${C.KIMI_CLI_VERSION}`)
})

test("OAuth constants match upstream kimi-cli exactly", () => {
  // Pinned values from research/kimi-cli/src/kimi_cli/auth/oauth.py. If these
  // drift from upstream, tokens are issued against the wrong scope/client and
  // the plugin no longer mirrors official kimi-cli auth.
  expect(C.OAUTH_HOST).toBe("https://auth.kimi.com")
  expect(C.OAUTH_DEVICE_AUTH_URL).toBe("https://auth.kimi.com/api/oauth/device_authorization")
  expect(C.OAUTH_TOKEN_URL).toBe("https://auth.kimi.com/api/oauth/token")
  expect(C.OAUTH_CLIENT_ID).toBe("17e5f671-d194-4dfb-9706-5516cb48c098")
  expect(C.OAUTH_SCOPE).toBe("kimi-code")
  expect(C.OAUTH_DEVICE_GRANT).toBe("urn:ietf:params:oauth:grant-type:device_code")
  expect(C.OAUTH_REFRESH_GRANT).toBe("refresh_token")
})

test("PROVIDER_ID does not collide with models.dev (AGENTS.md rule 8)", () => {
  expect(C.PROVIDER_ID).toBe("kimi-for-coding-oauth")
  expect(C.PROVIDER_ID).not.toBe("kimi-for-coding")
})

test("MODEL_ID goes over the wire verbatim (AGENTS.md rule 6)", () => {
  expect(C.MODEL_ID).toBe("kimi-for-coding")
})

test("REFRESH_SAFETY_WINDOW_MS is positive and well below token TTL", () => {
  // Token TTLs are ~15 min; anything bigger would mean we refresh on every call.
  expect(C.REFRESH_SAFETY_WINDOW_MS).toBeGreaterThan(0)
  expect(C.REFRESH_SAFETY_WINDOW_MS).toBeLessThan(5 * 60_000)
})
