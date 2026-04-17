import {
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
  let interval = Math.max(1, device.interval || 5) * 1000
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
  return postForm<TokenResponse>(OAUTH_TOKEN_URL, {
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refresh,
    grant_type: OAUTH_REFRESH_GRANT,
  })
}
