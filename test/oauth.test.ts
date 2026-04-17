import { test, expect, afterEach } from "bun:test"
import {
  OAUTH_CLIENT_ID,
  OAUTH_DEVICE_AUTH_URL,
  OAUTH_DEVICE_GRANT,
  OAUTH_REFRESH_GRANT,
  OAUTH_SCOPE,
  OAUTH_TOKEN_URL,
} from "../src/constants.ts"
import { pollDeviceToken, refreshToken, startDeviceAuth } from "../src/oauth.ts"
import { installFetchMock, parseForm } from "./_util/fetchMock.ts"

// oauth.ts calls kimiHeaders() on every request, which reads/writes
// ~/.kimi/device_id. That file is shared with kimi-cli by design and
// getDeviceId is idempotent — no HOME redirect needed.

let mock: ReturnType<typeof installFetchMock> | undefined
afterEach(() => {
  mock?.restore()
  mock = undefined
})

test("startDeviceAuth posts client_id+scope as form-encoded to the device endpoint", async () => {
  mock = installFetchMock(() => ({
    body: {
      device_code: "dc",
      user_code: "USER-1234",
      verification_uri: "https://auth.kimi.com/device",
      verification_uri_complete: "https://auth.kimi.com/device?u=USER-1234",
      expires_in: 600,
      interval: 5,
    },
  }))
  const d = await startDeviceAuth()
  expect(d.user_code).toBe("USER-1234")
  expect(mock.calls).toHaveLength(1)
  const call = mock.calls[0]!
  expect(call.url).toBe(OAUTH_DEVICE_AUTH_URL)
  expect(call.method).toBe("POST")
  expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded")
  // Fingerprint headers must be present on every oauth call, not just chat.
  expect(call.headers["x-msh-version"]).toBeDefined()
  expect(call.headers["x-msh-device-id"]).toMatch(/^[0-9a-f]{32}$/)
  expect(parseForm(call.body)).toEqual({
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPE,
  })
})

test("refreshToken posts grant_type=refresh_token and returns normalized shape", async () => {
  mock = installFetchMock(() => ({
    body: { access_token: "a2", refresh_token: "r2", token_type: "Bearer", expires_in: 900 },
  }))
  const t = await refreshToken("r1")
  expect(t).toEqual({ access_token: "a2", refresh_token: "r2", token_type: "Bearer", expires_in: 900 })
  const call = mock.calls[0]!
  expect(call.url).toBe(OAUTH_TOKEN_URL)
  expect(parseForm(call.body)).toEqual({
    client_id: OAUTH_CLIENT_ID,
    refresh_token: "r1",
    grant_type: OAUTH_REFRESH_GRANT,
  })
})

test("postForm wraps non-OK responses with error.code from the JSON body", async () => {
  mock = installFetchMock(() => ({
    status: 400,
    body: { error: "invalid_grant", error_description: "refresh token is dead" },
  }))
  await expect(refreshToken("bad")).rejects.toThrow(/invalid_grant/)
})

test("postForm throws a clear error when the server returns non-JSON", async () => {
  mock = installFetchMock(() => ({ status: 502, bodyText: "<html>gateway</html>" }))
  await expect(refreshToken("x")).rejects.toThrow(/non-JSON response/)
})

test("pollDeviceToken honors authorization_pending and returns on approval", async () => {
  // pollDeviceToken clamps with `device.interval || 5` then max(1, …)*1000,
  // so the effective poll wait is max(1, interval) seconds. Use interval=1
  // and a single pending cycle to keep the test ~2s.
  const device = {
    device_code: "dc",
    user_code: "U",
    verification_uri: "x",
    expires_in: 60,
    interval: 1,
  }
  mock = installFetchMock((_, i) => {
    if (i < 1) return { status: 400, body: { error: "authorization_pending" } }
    return { body: { access_token: "A", refresh_token: "R", token_type: "Bearer", expires_in: 900 } }
  })
  const t = await pollDeviceToken(device)
  expect(t.access_token).toBe("A")
  expect(mock.calls).toHaveLength(2)
  // Sends device_code + the RFC 8628 grant type.
  expect(parseForm(mock.calls[0]!.body)).toEqual({
    client_id: OAUTH_CLIENT_ID,
    device_code: "dc",
    grant_type: OAUTH_DEVICE_GRANT,
  })
})

test("pollDeviceToken surfaces expired_token with an actionable message", async () => {
  mock = installFetchMock(() => ({ status: 400, body: { error: "expired_token" } }))
  await expect(
    pollDeviceToken({ device_code: "dc", user_code: "U", verification_uri: "x", expires_in: 60, interval: 1 }),
  ).rejects.toThrow(/device code expired/)
})

test("pollDeviceToken rethrows unknown errors without looping", async () => {
  mock = installFetchMock(() => ({ status: 400, body: { error: "access_denied", error_description: "nope" } }))
  await expect(
    pollDeviceToken({ device_code: "dc", user_code: "U", verification_uri: "x", expires_in: 60, interval: 1 }),
  ).rejects.toThrow(/access_denied/)
  // Exactly one call; not retried.
  expect(mock!.calls).toHaveLength(1)
})
