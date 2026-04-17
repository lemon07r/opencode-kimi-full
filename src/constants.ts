// Values mirror kimi-cli v1.35.0 1:1. When upstream bumps, update here and
// nothing else in the codebase should hard-code these strings.
//
// Source of truth: research/kimi-cli/src/kimi_cli/constant.py,
// research/kimi-cli/src/kimi_cli/auth/oauth.py
//
// NOTE: client_id is a public constant shipped inside the official CLI, not a
// secret. scope `kimi-code` is what routes the issued JWT to K2.6.

export const KIMI_CLI_VERSION = "1.35.0"
export const USER_AGENT = `KimiCodeCLI/${KIMI_CLI_VERSION}`

export const OAUTH_HOST = "https://auth.kimi.com"
export const OAUTH_DEVICE_AUTH_URL = `${OAUTH_HOST}/api/oauth/device_authorization`
export const OAUTH_TOKEN_URL = `${OAUTH_HOST}/api/oauth/token`
export const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
export const OAUTH_SCOPE = "kimi-code"
export const OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
export const OAUTH_REFRESH_GRANT = "refresh_token"

export const API_BASE_URL = "https://api.kimi.com/coding/v1"
export const MODEL_ID = "kimi-for-coding"

// Refresh a bit before the server-reported expiry so we never race it.
export const REFRESH_SAFETY_WINDOW_MS = 60_000
