import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { API_BASE_URL, MODEL_ID, PROVIDER_ID, REFRESH_SAFETY_WINDOW_MS } from "./constants.ts"
import { kimiHeaders } from "./headers.ts"
import { type KimiModelInfo, listModels, pollDeviceToken, refreshToken, startDeviceAuth } from "./oauth.ts"

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

type ModelDiscovery = {
  model_id?: string
  context_length?: number
  model_display?: string
}

type ThinkingType = "enabled" | "disabled"

type KimiBodyFields = {
  prompt_cache_key?: string
  thinking?: { type: ThinkingType }
  reasoning_effort?: string
}

type ModelWithDiscoveryMetadata = {
  name?: string
  limit?: {
    context?: number
  }
}

type KimiHookInput = {
  sessionID: string
  model: {
    providerID: string
    id: string
    options?: Record<string, unknown>
    variants?: Record<string, Record<string, unknown>>
  }
  message: {
    model: {
      variant?: string
    }
  }
}

const INTERNAL_PROMPT_CACHE_KEY_HEADER = "x-opencode-kimi-prompt-cache-key"
const INTERNAL_REASONING_EFFORT_HEADER = "x-opencode-kimi-reasoning-effort"
const INTERNAL_THINKING_TYPE_HEADER = "x-opencode-kimi-thinking-type"
const REFRESH_LOCK_WAIT_MS = 15_000
const REFRESH_LOCK_POLL_MS = 100
const REFRESH_LOCK_STALE_MS = 120_000

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isOAuthAuth(value: unknown): value is OAuthAuth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const auth = value as Partial<OAuthAuth>
  return (
    auth.type === "oauth" &&
    typeof auth.access === "string" &&
    typeof auth.refresh === "string" &&
    typeof auth.expires === "number"
  )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function authStoreCandidates() {
  const home = os.homedir()
  if (process.env.XDG_DATA_HOME) {
    return [path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json")]
  }
  const candidates = new Set<string>()
  candidates.add(path.join(home, ".local", "share", "opencode", "auth.json"))
  if (process.platform === "darwin") {
    candidates.add(path.join(home, "Library", "Application Support", "opencode", "auth.json"))
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    candidates.add(path.join(local, "opencode", "auth.json"))
    if (process.env.APPDATA) {
      candidates.add(path.join(process.env.APPDATA, "opencode", "auth.json"))
    }
  }
  return [...candidates]
}

async function resolveAuthStorePath() {
  const candidates = authStoreCandidates()
  for (const file of candidates) {
    try {
      await fs.access(file)
      return file
    } catch {}
  }
  return candidates[0]!
}

async function readAuthStoreEntry() {
  for (const file of authStoreCandidates()) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
      const entry = parsed[PROVIDER_ID] ?? parsed[`${PROVIDER_ID}/`]
      if (isOAuthAuth(entry)) return entry
    } catch {}
  }
  return
}

function sameAuth(left: OAuthAuth, right: OAuthAuth) {
  return left.access === right.access && left.refresh === right.refresh && left.expires === right.expires
}

function withInvalidGrantHint(error: unknown) {
  if (!(error instanceof Error) || !/invalid_grant/.test(error.message)) return error
  const next = new Error(
    `${error.message}. The token may have been rotated or revoked in another opencode session — run \`opencode auth login kimi-for-coding-oauth\` again if it does not self-heal.`,
  ) as Error & { code?: string; status?: number }
  next.code = (error as Error & { code?: string }).code
  next.status = (error as Error & { status?: number }).status
  return next
}

async function withRefreshLock<T>(work: () => Promise<T>) {
  const authFile = await resolveAuthStorePath()
  const lockDir = `${authFile}.${PROVIDER_ID}.refresh.lock`
  await fs.mkdir(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS

  while (true) {
    try {
      await fs.mkdir(lockDir)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST") throw error
      try {
        const stat = await fs.stat(lockDir)
        if (Date.now() - stat.mtimeMs > REFRESH_LOCK_STALE_MS) {
          await fs.rm(lockDir, { recursive: true, force: true })
          continue
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error("kimi oauth: timed out waiting for the auth refresh lock")
      }
      await sleep(REFRESH_LOCK_POLL_MS)
    }
  }

  try {
    return await work()
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function asThinking(value: unknown): KimiBodyFields["thinking"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const type = (value as { type?: unknown }).type
  if (type !== "enabled" && type !== "disabled") return
  return { type }
}

function pickEffort(options: Record<string, unknown> | undefined) {
  const effort = options?.reasoning_effort ?? options?.reasoningEffort
  return typeof effort === "string" ? effort : undefined
}

function resolveKimiBodyFields(input: KimiHookInput): KimiBodyFields | undefined {
  if (input.model.providerID !== PROVIDER_ID) return
  if (input.model.id !== MODEL_ID) return

  const modelOptions = asRecord(input.model.options)
  const variantOptions = input.message.model.variant
    ? asRecord(input.model.variants?.[input.message.model.variant])
    : undefined

  const fields: KimiBodyFields = { prompt_cache_key: input.sessionID }
  const thinking = asThinking(variantOptions?.thinking) ?? asThinking(modelOptions?.thinking)
  const effort = pickEffort(variantOptions) ?? pickEffort(modelOptions)

  if (effort === "auto") return fields
  if (effort === "off") {
    fields.thinking = { type: "disabled" }
    return fields
  }
  if (effort) fields.reasoning_effort = effort
  fields.thinking = thinking ?? { type: "enabled" }
  return fields
}

function applyKimiBodyFields(target: Record<string, unknown>, fields: KimiBodyFields) {
  target.prompt_cache_key = fields.prompt_cache_key
  if (fields.reasoning_effort) {
    target.reasoning_effort = fields.reasoning_effort
  } else {
    delete target.reasoning_effort
  }
  delete target.reasoningEffort
  if (fields.thinking) {
    target.thinking = fields.thinking
    return
  }
  delete target.thinking
}

function consumeInternalKimiBodyFields(headers: Headers): KimiBodyFields {
  const fields: KimiBodyFields = {}
  const promptCacheKey = headers.get(INTERNAL_PROMPT_CACHE_KEY_HEADER)
  if (promptCacheKey) fields.prompt_cache_key = promptCacheKey
  const reasoningEffort = headers.get(INTERNAL_REASONING_EFFORT_HEADER)
  if (reasoningEffort) fields.reasoning_effort = reasoningEffort
  const thinkingType = headers.get(INTERNAL_THINKING_TYPE_HEADER)
  if (thinkingType === "enabled" || thinkingType === "disabled") {
    fields.thinking = { type: thinkingType }
  }
  headers.delete(INTERNAL_PROMPT_CACHE_KEY_HEADER)
  headers.delete(INTERNAL_REASONING_EFFORT_HEADER)
  headers.delete(INTERNAL_THINKING_TYPE_HEADER)
  return fields
}

function hasKimiBodyFields(fields: KimiBodyFields) {
  return Boolean(fields.prompt_cache_key || fields.reasoning_effort || fields.thinking)
}

function pickModelInfo(models: KimiModelInfo[]): ModelDiscovery {
  const picked = models.find((m) => m.id === MODEL_ID) ?? models[0]
  if (!picked) return {}
  return {
    model_id: picked.id,
    context_length: picked.context_length,
    model_display: picked.display_name,
  }
}

function withDiscoveredContext<T extends ModelWithDiscoveryMetadata>(model: T, contextLength: number | undefined): T {
  if (!contextLength || contextLength <= 0) return model
  if ((model.limit?.context ?? 0) > 0) return model
  return {
    ...model,
    limit: {
      ...model.limit,
      context: contextLength,
    },
  }
}

function withDiscoveredDisplayName<T extends ModelWithDiscoveryMetadata>(model: T, displayName: string | undefined): T {
  if (!displayName || model.name === displayName) return model
  return {
    ...model,
    name: displayName,
  }
}

function applyDiscoveryToModels<T extends Record<string, ModelWithDiscoveryMetadata>>(models: T, discovery: ModelDiscovery): T {
  const current = models[MODEL_ID]
  if (!current) return models
  const next = withDiscoveredContext(withDiscoveredDisplayName(current, discovery.model_display), discovery.context_length)
  if (next === current) return models
  return {
    ...models,
    [MODEL_ID]: next,
  }
}

function buildConfigBlock(info: { model_id: string; display?: string }) {
  const name = info.display ?? "Kimi For Coding"
  // The opencode-side model key is always MODEL_ID ("kimi-for-coding"); the
  // plugin rewrites the wire `model` body field to `info.model_id` inside
  // `loader.fetch`. This way users paste identical config even if the
  // server reports a different wire slug for their account.
  //
  // Intentionally omit `limit`: opencode's config schema requires
  // `limit.output` whenever a `limit` object is present, but Kimi's
  // `/coding/v1/models` discovery only tells us `context_length`. The
  // provider.models hook backfills `limit.context` at runtime.
  return JSON.stringify(
    {
      provider: {
        [PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Kimi For Coding (OAuth)",
          options: { baseURL: API_BASE_URL },
          models: {
            [MODEL_ID]: {
              name,
              reasoning: true,
              options: {},
              variants: {
                off: { reasoning_effort: "off" },
                auto: { reasoning_effort: "auto" },
                low: { reasoning_effort: "low" },
                medium: { reasoning_effort: "medium" },
                high: { reasoning_effort: "high" },
              },
            },
          },
        },
      },
    },
    null,
    2,
  )
}

/**
 * Plugin entry point.
 *
 * Responsibilities, in order of execution:
 *   1. `auth`    — register device-flow OAuth login under the
 *                  `kimi-for-coding-oauth` provider id. opencode persists the returned tokens in its
 *                  own auth.json; the plugin also live-reads that file so
 *                  workspace auth snapshots do not strand stale refresh
 *                  tokens.
 *   2. `loader`  — runs every time opencode instantiates the provider. Returns
 *                  a custom `fetch` that (a) refreshes the access token when
 *                  it is about to expire, (b) injects the seven X-Msh-* / UA
 *                  headers on every upstream call (models list, chat, etc.),
 *                  (c) lazily discovers the current wire model id from
 *                  `GET /coding/v1/models`, and (d) retries once with a forced
 *                  refresh on 401.
 *   3. `provider.models` — discovers `context_length` / `display_name` early
 *                  enough to patch opencode's runtime model metadata when the
 *                  user's config still has the default placeholder values.
 *   4. `chat.headers` — computes the Kimi-specific request body fields the
 *                  model actually needs (`thinking.type`,
 *                  `reasoning_effort`, `prompt_cache_key`) and passes them to
 *                  `loader.fetch` via private headers.
 *   5. `chat.params` — mirrors the same fields into `output.options` for
 *                  forward-compat if opencode fixes its current
 *                  openai-compatible providerOptions namespace mismatch.
 */
const plugin: Plugin = async ({ client }) => {
  // --- helpers ---------------------------------------------------------------

  let cachedDiscovery: ModelDiscovery = {}
  let refreshPromise: Promise<OAuthAuth> | undefined

  const syncProcessAuthContent = (auth: OAuthAuth) => {
    if (!process.env.OPENCODE_AUTH_CONTENT) return
    try {
      const parsed = JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, unknown>
      delete parsed[`${PROVIDER_ID}/`]
      parsed[PROVIDER_ID] = auth
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(parsed)
    } catch {}
  }

  const persistAuth = async (auth: OAuthAuth) => {
    await client.auth.set({ path: { id: PROVIDER_ID }, body: auth })
    syncProcessAuthContent(auth)
  }

  const isExpiring = (auth: OAuthAuth) => auth.expires - Date.now() < REFRESH_SAFETY_WINDOW_MS

  const rememberDiscovery = (discovery: ModelDiscovery) => {
    if (discovery.model_id) cachedDiscovery = discovery
    return cachedDiscovery
  }

  const readLiveAuth = async () => {
    const auth = await readAuthStoreEntry()
    if (auth) syncProcessAuthContent(auth)
    return auth
  }

  const readCurrentAuth = async (readAuth?: () => Promise<unknown>) => {
    const live = await readLiveAuth()
    if (live) return live
    if (!readAuth) return
    const current = await readAuth()
    if (!isOAuthAuth(current)) return
    syncProcessAuthContent(current)
    return current
  }

  const refreshAuth = async (auth: OAuthAuth, force = false) => {
    // opencode can ask both `provider.models` and `loader.fetch` to refresh
    // around the same time, including from separate workspace processes that
    // only inherited a stale `OPENCODE_AUTH_CONTENT` snapshot. Serialize
    // refreshes through a lock and re-read opencode's live auth store before
    // spending the refresh token.
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      try {
        return await withRefreshLock(async () => {
          const latest = await readLiveAuth()
          const current = latest ?? auth
          if (latest && !sameAuth(latest, auth) && !force && !isExpiring(latest)) return latest
          if (!force && !isExpiring(current)) return current
          try {
            const tokens = await refreshToken(current.refresh)
            const next: OAuthAuth = {
              type: "oauth",
              refresh: tokens.refresh_token,
              access: tokens.access_token,
              expires: Date.now() + tokens.expires_in * 1000,
            }
            await persistAuth(next)
            return next
          } catch (error) {
            const newest = await readLiveAuth()
            if (newest && !sameAuth(newest, current)) return newest
            throw withInvalidGrantHint(error)
          }
        })
      } finally {
        refreshPromise = undefined
      }
    })()
    return refreshPromise
  }

  // --- return hooks ----------------------------------------------------------

  return {
    provider: {
      id: PROVIDER_ID,
      models: async (provider, ctx) => {
        if (!isOAuthAuth(ctx.auth)) return provider.models

        const discover = async (auth: OAuthAuth) =>
          applyDiscoveryToModels(provider.models, rememberDiscovery(pickModelInfo(await listModels(auth.access))))

        const current = (await readCurrentAuth()) ?? ctx.auth
        let auth = current
        try {
          if (isExpiring(auth)) auth = await refreshAuth(auth)
          return await discover(auth)
        } catch (error) {
          if (auth !== current || (error as { status?: number }).status !== 401) return provider.models
        }

        try {
          return await discover(await refreshAuth(current, true))
        } catch {
          return provider.models
        }
      },
    },
    auth: {
      provider: PROVIDER_ID,

      /**
       * Called every time opencode creates an `@ai-sdk/openai-compatible`
       * instance for this provider. We inject a `fetch` that owns all auth
       * and header concerns so no other hook has to worry about them.
       *
       * `readAuth` comes from opencode: it returns the currently persisted
       * credentials for this provider id. opencode workspace processes may
       * hydrate that from a stale `OPENCODE_AUTH_CONTENT` snapshot, so the
       * loader prefers the live auth.json entry on disk and only falls back to
       * `readAuth` when the file is absent. Writes still go through
       * `client.auth.set`.
       */
      loader: async (readAuth) => {
        let discovery: ModelDiscovery = cachedDiscovery

        const discoverModelInfo = async (access: string): Promise<ModelDiscovery> => {
          // opencode's SDK auth schema only persists the standard oauth fields
          // (`refresh`/`access`/`expires`) on `client.auth.set`, so discovery
          // cannot live durably in auth.json across refresh writes. Cache it in
          // this loader instance instead, and repopulate lazily on startup.
          discovery = rememberDiscovery(pickModelInfo(await listModels(access)))
          return discovery
        }

        const ensureDiscovered = async (auth: OAuthAuth & Partial<ModelDiscovery>) => {
          if (!discovery.model_id && auth.model_id) {
            discovery = {
              model_id: auth.model_id,
              context_length: auth.context_length,
              model_display: auth.model_display,
            }
            cachedDiscovery = discovery
          }
          if (discovery.model_id) return { ...auth, ...discovery }
          try {
            return { ...auth, ...(await discoverModelInfo(auth.access)) }
          } catch {
            return { ...auth, ...discovery }
          }
        }

        const ensureFresh = async (force = false): Promise<OAuthAuth & ModelDiscovery> => {
          const current = (await readCurrentAuth(readAuth)) as (OAuthAuth & Partial<ModelDiscovery>) | undefined
          if (!current || current.type !== "oauth")
            throw new Error(
              "kimi-for-coding-oauth: not logged in — run `opencode auth login kimi-for-coding-oauth`",
            )
          if (!force && !isExpiring(current)) return ensureDiscovered(current)
          const next = await refreshAuth(current, force)
          // kimi-cli re-runs `refresh_managed_models` on every successful
          // refresh — we mirror that so entitlement or display-name changes
          // are picked up without a full re-login. Failures here must not
          // block the refresh: a
          // warm in-memory discovery still works for the common case, and
          // the request-path 401 retry will flush a broken access token.
          try {
            await discoverModelInfo(next.access)
          } catch {
            /* keep previous discovery */
          }
          return { ...next, ...discovery }
        }

        return {
          // We own the Authorization header entirely, but opencode still
          // requires a truthy apiKey to wire things up; use a sentinel.
          apiKey: "kimi-for-coding-oauth",
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const doRequest = async (auth: OAuthAuth & ModelDiscovery) => {
              const headers = new Headers(input instanceof Request ? input.headers : undefined)
              new Headers(init?.headers).forEach((value, key) => {
                headers.set(key, value)
              })
              // opencode currently namespaces providerOptions for
              // @ai-sdk/openai-compatible under the provider id, while the SDK
              // reads them back under the human provider name. Carry Kimi-only
              // body fields through private headers instead so the wire request
              // stays correct regardless of that upstream mismatch.
              const kimiBodyFields = consumeInternalKimiBodyFields(headers)
              // Strip anything the upstream SDK put on. Our values win.
              headers.delete("authorization")
              headers.delete("Authorization")
              for (const [k, v] of Object.entries(kimiHeaders())) headers.set(k, v)
              headers.set("Authorization", `Bearer ${auth.access}`)

              // Rewrite the wire `model` to the server-discovered id.
              // opencode bakes the model id into the LanguageModel instance
              // at provider-init time (via `provider.chatModel(modelId)`),
              // so `chat.params` cannot change it. We rewrite the JSON
              // body here instead. Only touches requests where:
              //   - we have a discovered id that differs from what opencode
              //     sent (otherwise leave the body untouched),
              //   - the body is JSON with a string `model` field equal to
              //     our opencode-side placeholder MODEL_ID.
              // This way `input.model.id` stays `kimi-for-coding` in
              // opencode's UI/config, while Moonshot sees whatever its
              // /models endpoint says for this account (for example a
              // non-default slug). Mirrors kimi-cli's behavior — it always sends
              // exactly the id it got back from `/models`.
              let newInit = init
              const targetModel = auth.model_id
              const originalBody =
                typeof init?.body === "string"
                  ? init.body
                  : input instanceof Request && init?.body === undefined
                    ? await input
                        .clone()
                        .text()
                        .catch(() => undefined)
                    : undefined
              if (((targetModel && targetModel !== MODEL_ID) || hasKimiBodyFields(kimiBodyFields)) && originalBody) {
                try {
                  const parsed = JSON.parse(originalBody)
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    if (targetModel && targetModel !== MODEL_ID && parsed.model === MODEL_ID) {
                      parsed.model = targetModel
                    }
                    if (hasKimiBodyFields(kimiBodyFields)) {
                      applyKimiBodyFields(parsed as Record<string, unknown>, kimiBodyFields)
                    }
                    newInit = { ...init, body: JSON.stringify(parsed) }
                  }
                } catch {
                  /* non-JSON body, e.g. multipart — leave alone */
                }
              }

              return fetch(input, { ...newInit, headers })
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
                  // Discover the account's real model entitlement right
                  // after approval (mirrors kimi-cli's login flow).
                  // Failures here degrade gracefully — the plugin still
                  // works; users just don't see the config-block hint and
                  // the loader will re-attempt discovery before the first
                  // model-rewrite that needs it.
                  try {
                    const discovered = pickModelInfo(await listModels(tokens.access_token))
                    if (discovered.model_id) {
                      // Print a ready-to-paste config block. opencode shows
                      // this next to the "Authorized" message.
                      const block = buildConfigBlock({
                        model_id: discovered.model_id,
                        display: discovered.model_display,
                      })
                      console.log(
                        `\n✓ Authorized for Kimi For Coding (model: ${discovered.model_id}${
                          discovered.context_length ? `, context ${discovered.context_length}` : ""
                        })\n\nAdd this to your opencode config (~/.config/opencode/opencode.json) if you haven't already:\n\n${block}\n`,
                      )
                    }
                  } catch {
                    /* non-fatal */
                  }
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

    "chat.headers": async (input, output) => {
      const fields = resolveKimiBodyFields(input as KimiHookInput)
      if (!fields) return
      if (fields.prompt_cache_key) {
        output.headers[INTERNAL_PROMPT_CACHE_KEY_HEADER] = fields.prompt_cache_key
      }
      if (fields.reasoning_effort) {
        output.headers[INTERNAL_REASONING_EFFORT_HEADER] = fields.reasoning_effort
      }
      if (fields.thinking) {
        output.headers[INTERNAL_THINKING_TYPE_HEADER] = fields.thinking.type
      }
    },

    /**
     * Mirror Kimi-specific body fields into providerOptions when possible.
     *
     * The real load-bearing path is `chat.headers` → `loader.fetch`, because
     * current opencode/openai-compatible builds disagree on the providerOptions
     * namespace. We still normalize `output.options` so the plugin keeps
     * working if upstream aligns those keys later.
     */
    "chat.params": async (input, output) => {
      const fields = resolveKimiBodyFields(input as KimiHookInput)
      if (!fields) return
      applyKimiBodyFields(output.options, fields)
    },
  }
}

export default plugin
