import type { Plugin } from "@opencode-ai/plugin"
import { MODEL_ID, PROVIDER_ID, REFRESH_SAFETY_WINDOW_MS } from "./constants.ts"
import { kimiHeaders } from "./headers.ts"
import { pollDeviceToken, refreshToken, startDeviceAuth } from "./oauth.ts"

// IMPORTANT: this module must have exactly ONE export — the default plugin
// function. opencode's plugin loader (packages/opencode/src/plugin/index.ts →
// getLegacyPlugins) iterates every export and throws "Plugin export is not a
// function" if any named export is not a function. Keep constants in
// constants.ts and import them here.

type OAuthAuth = {
  type: "oauth"
  refresh: string
  access: string
  expires: number
}

/**
 * Plugin entry point.
 *
 * Responsibilities, in order of execution:
 *   1. `auth`    — register device-flow OAuth login under the
 *                  `kimi-for-coding-oauth` provider id. opencode persists the returned tokens in its
 *                  own auth.json; we never touch disk for credentials.
 *   2. `loader`  — runs every time opencode instantiates the provider. Returns
 *                  a custom `fetch` that (a) refreshes the access token when
 *                  it is about to expire, (b) injects the seven X-Msh-* / UA
 *                  headers on every upstream call (models list, chat, etc.),
 *                  and (c) retries once with a forced refresh on 401.
 *   3. `chat.params` — adds the Kimi-specific request body fields the model
 *                  actually needs: `thinking.type`, `reasoning_effort`, and
 *                  `prompt_cache_key`. These are placed under the SDK-scoped
 *                  options bag so `@ai-sdk/openai-compatible` forwards them
 *                  verbatim as top-level JSON body fields.
 */
const plugin: Plugin = async ({ client }) => {
  // --- helpers ---------------------------------------------------------------

  const persistAuth = async (auth: OAuthAuth) => {
    await client.auth.set({ path: { id: PROVIDER_ID }, body: auth })
  }

  const isExpiring = (auth: OAuthAuth) => auth.expires - Date.now() < REFRESH_SAFETY_WINDOW_MS

  // --- return hooks ----------------------------------------------------------

  return {
    auth: {
      provider: PROVIDER_ID,

      /**
       * Called every time opencode creates an `@ai-sdk/openai-compatible`
       * instance for this provider. We inject a `fetch` that owns all auth
       * and header concerns so no other hook has to worry about them.
       *
       * `readAuth` comes from opencode: it returns the currently persisted
       * credentials for this provider id (opencode's `auth.json`). The SDK
       * client intentionally does not expose a `get` — reading is scoped to
       * this loader callback. Writes still go through `client.auth.set`.
       */
      loader: async (readAuth) => {
        const ensureFresh = async (force = false): Promise<OAuthAuth> => {
          const current = (await readAuth()) as OAuthAuth | undefined
          if (!current || current.type !== "oauth")
            throw new Error(
              "kimi-for-coding-oauth: not logged in — run `opencode auth login kimi-for-coding-oauth`",
            )
          if (!force && !isExpiring(current)) return current
          const tokens = await refreshToken(current.refresh)
          const next: OAuthAuth = {
            type: "oauth",
            refresh: tokens.refresh_token,
            access: tokens.access_token,
            expires: Date.now() + tokens.expires_in * 1000,
          }
          await persistAuth(next)
          return next
        }

        return {
          // We own the Authorization header entirely, but opencode still
          // requires a truthy apiKey to wire things up; use a sentinel.
          apiKey: "kimi-for-coding-oauth",
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const doRequest = async (auth: OAuthAuth) => {
              const headers = new Headers(init?.headers)
              // Strip anything the upstream SDK put on. Our values win.
              headers.delete("authorization")
              headers.delete("Authorization")
              for (const [k, v] of Object.entries(kimiHeaders())) headers.set(k, v)
              headers.set("Authorization", `Bearer ${auth.access}`)
              return fetch(input, { ...init, headers })
            }

            let auth = await ensureFresh()
            let res = await doRequest(auth)
            if (res.status === 401) {
              // Token might have been invalidated server-side before its
              // nominal expiry. Force a refresh and retry exactly once.
              auth = await ensureFresh(true)
              res = await doRequest(auth)
            }
            return res
          },
        }
      },

      methods: [
        {
          type: "oauth",
          label: "Kimi Code (device flow)",
          authorize: async () => {
            const device = await startDeviceAuth()
            const url = device.verification_uri_complete ?? device.verification_uri
            return {
              url,
              instructions: `Open the URL above and approve code ${device.user_code}. This window will continue automatically.`,
              method: "auto",
              callback: async () => {
                try {
                  const tokens = await pollDeviceToken(device)
                  return {
                    type: "success",
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + tokens.expires_in * 1000,
                  }
                } catch {
                  return { type: "failed" }
                }
              },
            }
          },
        },
      ],
    },

    /**
     * Inject Kimi-specific body fields.
     *
     * kimi-cli sends BOTH `reasoning_effort` and a `thinking` object at the
     * top level. The @ai-sdk/openai-compatible SDK forwards unknown keys in
     * `providerOptions[<sdkKey>]` as top-level body fields, which is exactly
     * what we need. The sdkKey for @ai-sdk/openai-compatible is the
     * providerID, so we write to `output.options` which opencode then wraps
     * as `{ [providerID]: options }` via ProviderTransform.providerOptions.
     */
    "chat.params": async (input, output) => {
      // Gate on model.providerID (the field opencode's llm.ts actually
      // populates — `input.provider` is the flat `ProviderConfig` passed by
      // `packages/opencode/src/session/llm.ts::stream`, so `input.provider.id`
      // works too, but the @opencode-ai/plugin type for `ProviderContext`
      // claims `.info.id` exists — the runtime shape disagrees. Using
      // `input.model.providerID` is what every first-party plugin does
      // (cloudflare.ts, codex.ts, github-copilot/copilot.ts).
      if (input.model.providerID !== PROVIDER_ID) return
      if (input.model.id !== MODEL_ID) return

      // `prompt_cache_key` — stable per conversation so the backend can reuse
      // its KV cache across turns. opencode's sessionID is exactly that.
      output.options.prompt_cache_key = input.sessionID

      // Thinking / reasoning effort. We mirror kimi-cli's mapping:
      //   - effort `off`   → no reasoning_effort, thinking.type = "disabled"
      //   - effort `auto`  → omit both; let Moonshot pick dynamically
      //   - effort ∈ {low, medium, high} → reasoning_effort = effort,
      //     thinking.type = "enabled"
      //
      // Effort is read from opencode's options bag. It may be present as:
      //   - `reasoning_effort` (wire shape; what model.variants typically set)
      //   - `reasoningEffort`  (opencode camelCase passthrough)
      //   - `reasoning.effort` / `providerOptions.<id>.reasoningEffort` (rare)
      // We accept the first two, normalize, and leave any caller-supplied
      // `thinking` object alone if they already set one.
      const effort = output.options.reasoning_effort ?? output.options.reasoningEffort
      if (effort === "auto") {
        // Explicit "auto" variant: remove both knobs so the server picks.
        delete output.options.reasoning_effort
        delete output.options.reasoningEffort
        delete output.options.thinking
      } else if (typeof effort === "string" && effort !== "off") {
        output.options.reasoning_effort = effort
        delete output.options.reasoningEffort
        output.options.thinking = output.options.thinking ?? { type: "enabled" }
      } else if (effort === "off") {
        delete output.options.reasoning_effort
        delete output.options.reasoningEffort
        output.options.thinking = { type: "disabled" }
      } else if (!output.options.thinking) {
        // No effort set at all → thinking enabled, no reasoning_effort
        // (server picks). Matches kimi-cli's "nothing passed" default.
        output.options.thinking = { type: "enabled" }
      }
    },
  }
}

export default plugin
