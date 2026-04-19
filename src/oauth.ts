import {
  API_BASE_URL,
  OAUTH_CLIENT_ID,
  OAUTH_DEVICE_AUTH_URL,
  OAUTH_DEVICE_GRANT,
  OAUTH_REFRESH_GRANT,
  OAUTH_SCOPE,
  OAUTH_TOKEN_URL,
} from "./constants.ts"
import { kimiHeaders } from "./headers.ts"

export type DeviceAuth = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

export type TokenResponse = {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

const REFRESH_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
const REFRESH_MAX_RETRIES = 3
// Mirror kimi-cli's default aiohttp session timeout
// (research/kimi-cli/src/kimi_cli/utils/aiohttp.py).
const REQUEST_TIMEOUT_MS = 120_000

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}

async function postForm<T>(url: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...kimiHeaders(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formBody(params),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  let json: any
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`kimi oauth: non-JSON response from ${url} (status ${res.status}): ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const code = json.error ?? res.status
    const msg = json.error_description ?? text
    const err = new Error(`kimi oauth ${code}: ${msg}`) as Error & { code?: string; status?: number }
    err.code = json.error
    err.status = res.status
    throw err
  }
  return json as T
}

export async function startDeviceAuth(): Promise<DeviceAuth> {
  return postForm<DeviceAuth>(OAUTH_DEVICE_AUTH_URL, {
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPE,
  })
}

/**
 * Polls the token endpoint until the user approves the device code, the
 * device code expires, or an unexpected error occurs. Honors `authorization_pending`
 * and `slow_down` per RFC 8628.
 */
export async function pollDeviceToken(device: DeviceAuth): Promise<TokenResponse> {
  let interval = Math.max(1, device.interval ?? 5) * 1000
  const deadline = Date.now() + device.expires_in * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval))
    try {
      return await postForm<TokenResponse>(OAUTH_TOKEN_URL, {
        client_id: OAUTH_CLIENT_ID,
        device_code: device.device_code,
        grant_type: OAUTH_DEVICE_GRANT,
      })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === "authorization_pending") continue
      if (code === "slow_down") {
        interval += 5_000
        continue
      }
      if (code === "expired_token") throw new Error("kimi oauth: device code expired — run login again")
      throw err
    }
  }
  throw new Error("kimi oauth: device code expired before the user approved it")
}

export async function refreshToken(refresh: string): Promise<TokenResponse> {
  let lastError: unknown
  for (let attempt = 0; attempt < REFRESH_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          ...kimiHeaders(),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: formBody({
          client_id: OAUTH_CLIENT_ID,
          refresh_token: refresh,
          grant_type: OAUTH_REFRESH_GRANT,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const text = await res.text()
      let json: any = {}
      try {
        json = text ? JSON.parse(text) : {}
      } catch {
        if (REFRESH_RETRYABLE_STATUSES.has(res.status)) {
          const err = new Error(
            `kimi oauth refresh transient ${res.status}: non-JSON response: ${text.slice(0, 200)}`,
          ) as Error & { status?: number }
          err.status = res.status
          throw err
        }
        const err = new Error(
          `kimi oauth: non-JSON response from ${OAUTH_TOKEN_URL} (status ${res.status}): ${text.slice(0, 200)}`,
        ) as Error & { status?: number }
        err.status = res.status
        throw err
      }

      if (res.status === 401 || res.status === 403) {
        const err = new Error(`kimi oauth ${json.error ?? res.status}: ${json.error_description ?? text}`) as Error & {
          status?: number
        }
        err.status = res.status
        throw err
      }

      if (!res.ok) {
        const err = new Error(`kimi oauth ${json.error ?? res.status}: ${json.error_description ?? text}`) as Error & {
          code?: string
          status?: number
        }
        err.code = json.error
        err.status = res.status
        throw err
      }

      return json as TokenResponse
    } catch (err) {
      const status = (err as { status?: number }).status
      const retryable = status === undefined || REFRESH_RETRYABLE_STATUSES.has(status)
      lastError = err
      if (!retryable || attempt === REFRESH_MAX_RETRIES - 1) throw err
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000))
    }
  }

  throw lastError instanceof Error ? lastError : new Error("kimi oauth: token refresh failed")
}

/**
 * Shape of each entry in `GET /coding/v1/models`. Field set mirrors what
 * kimi-cli reads — see research/kimi-cli/src/kimi_cli/auth/platforms.py
 * `_list_models`. Unused-by-this-plugin flags are kept optional for
 * documentation; the wire response carries them either way.
 */
export type KimiModelInfo = {
  id: string
  display_name?: string
  context_length?: number
  supports_reasoning?: boolean
  supports_image_in?: boolean
  supports_video_in?: boolean
}

/**
 * Calls `GET {API_BASE_URL}/models` with the user's JWT and returns the
 * server's authoritative model list for this account. Different account
 * tiers see different slugs (K2.5 accounts may see `k2p5`, K2.6 accounts
 * see `kimi-for-coding`); the `id` and `context_length` here are the only
 * truth about what the user is actually entitled to.
 *
 * kimi-cli calls this on login and on every successful token refresh
 * (see `refresh_managed_models` in platforms.py). We do the same.
 */
export async function listModels(accessToken: string): Promise<KimiModelInfo[]> {
  const res = await fetch(`${API_BASE_URL}/models`, {
    headers: {
      ...kimiHeaders(),
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`kimi list-models ${res.status}: ${text.slice(0, 200)}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`kimi list-models: non-JSON response: ${text.slice(0, 200)}`)
  }
  const data = Array.isArray(json?.data) ? json.data : []
  return data.filter((m: any) => typeof m?.id === "string") as KimiModelInfo[]
}
