import { test, expect, afterEach } from "bun:test"
import plugin from "../src/index.ts"
import { MODEL_ID, PROVIDER_ID, REFRESH_SAFETY_WINDOW_MS } from "../src/constants.ts"
import { installFetchMock } from "./_util/fetchMock.ts"

// kimiHeaders() → getDeviceId() reads/writes ~/.kimi/device_id; that file is
// shared with kimi-cli by design and writes are idempotent — no HOME
// redirect needed.

let mock: ReturnType<typeof installFetchMock> | undefined
afterEach(() => {
  mock?.restore()
  mock = undefined
})

// Fake opencode plugin context. Only `client.auth.set` is used by the
// plugin's writes; reads go through the `readAuth` callback passed to
// `loader`, not through client.
function makeContext() {
  const writes: Array<{ id: string; body: unknown }> = []
  return {
    writes,
    ctx: {
      client: {
        auth: {
          set: async ({ path, body }: { path: { id: string }; body: unknown }) => {
            writes.push({ id: path.id, body })
          },
        },
      },
    } as unknown as Parameters<typeof plugin>[0],
  }
}

async function getHooks() {
  const { ctx, writes } = makeContext()
  const hooks = await plugin(ctx)
  return { hooks, writes }
}

// ---------- chat.params -----------------------------------------------------

// Minimal shape for input/output we care about in the params hook.
// Mirrors the runtime shape opencode actually passes (see
// research/opencode/packages/opencode/src/session/llm.ts::stream — `model`
// has `.providerID` and `.id`; `provider` is the flat ProviderConfig).
type ParamsInput = {
  provider: { id: string }
  model: { providerID: string; id: string }
  sessionID: string
}
type ParamsOutput = { options: Record<string, unknown> }
function callParams(
  hook: (i: ParamsInput, o: ParamsOutput) => Promise<void> | void,
  providerID: string,
  modelID: string,
  options: Record<string, unknown> = {},
  sessionID = "sess-1",
) {
  const output: ParamsOutput = { options: { ...options } }
  const res = hook(
    { provider: { id: providerID }, model: { providerID, id: modelID }, sessionID },
    output,
  )
  return { res, output }
}

test("chat.params: no-op for other providers (AGENTS.md rule: gated on PROVIDER_ID)", async () => {
  const { hooks } = await getHooks()
  const hook = hooks["chat.params"]!
  const { output } = callParams(hook, "some-other-provider", MODEL_ID, { reasoning_effort: "high" })
  // Untouched — no prompt_cache_key, no thinking added.
  expect(output.options).toEqual({ reasoning_effort: "high" })
})

test("chat.params: no-op for other models under our provider (rule 5 gating)", async () => {
  const { hooks } = await getHooks()
  const hook = hooks["chat.params"]!
  const { output } = callParams(hook, PROVIDER_ID, "kimi-something-else")
  expect(output.options.prompt_cache_key).toBeUndefined()
  expect(output.options.thinking).toBeUndefined()
})

test("chat.params: attaches prompt_cache_key = sessionID for kimi-for-coding only", async () => {
  const { hooks } = await getHooks()
  const hook = hooks["chat.params"]!
  const { output } = await callParams(hook, PROVIDER_ID, MODEL_ID, {}, "sess-42")
  expect(output.options.prompt_cache_key).toBe("sess-42")
})

// The effort matrix is the most load-bearing contract in AGENTS.md → rule 4.
// Off  → thinking disabled, reasoning_effort stripped.
// low/medium/high → reasoning_effort kept, thinking enabled.
// unset → thinking enabled, no reasoning_effort (server-picks default).
const EFFORT_MATRIX: Array<{
  in: Record<string, unknown>
  effort: string | undefined
  thinkingType: "enabled" | "disabled"
}> = [
  { in: { reasoning_effort: "off" }, effort: undefined, thinkingType: "disabled" },
  { in: { reasoning_effort: "low" }, effort: "low", thinkingType: "enabled" },
  { in: { reasoning_effort: "medium" }, effort: "medium", thinkingType: "enabled" },
  { in: { reasoning_effort: "high" }, effort: "high", thinkingType: "enabled" },
  { in: {}, effort: undefined, thinkingType: "enabled" },
]

test("chat.params: effort=auto → no reasoning_effort, no thinking (server picks dynamically)", async () => {
  const { hooks } = await getHooks()
  const { output } = await callParams(hooks["chat.params"]!, PROVIDER_ID, MODEL_ID, {
    reasoning_effort: "auto",
  })
  expect(output.options.reasoning_effort).toBeUndefined()
  expect(output.options.reasoningEffort).toBeUndefined()
  expect(output.options.thinking).toBeUndefined()
})
for (const row of EFFORT_MATRIX) {
  test(`chat.params: effort=${JSON.stringify(row.in)} → effort=${row.effort}, thinking=${row.thinkingType}`, async () => {
    const { hooks } = await getHooks()
    const { output } = await callParams(hooks["chat.params"]!, PROVIDER_ID, MODEL_ID, row.in)
    expect(output.options.reasoning_effort).toBe(row.effort)
    expect(output.options.thinking).toEqual({ type: row.thinkingType })
  })
}

test("chat.params: `reasoningEffort` (camelCase) input also drives the mapping", async () => {
  // opencode may use camelCase upstream; the plugin accepts either.
  const { hooks } = await getHooks()
  const { output } = await callParams(hooks["chat.params"]!, PROVIDER_ID, MODEL_ID, { reasoningEffort: "off" })
  expect(output.options.thinking).toEqual({ type: "disabled" })
  expect(output.options.reasoning_effort).toBeUndefined()
  expect(output.options.reasoningEffort).toBeUndefined()
})

// ---------- auth.loader -----------------------------------------------------

function jwt() {
  return "header.payload.sig"
}
function validAuth(overrides: Partial<{ access: string; refresh: string; expires: number }> = {}) {
  return {
    type: "oauth" as const,
    access: overrides.access ?? "access-1",
    refresh: overrides.refresh ?? "refresh-1",
    // Far enough in the future to skip the refresh-on-expiry path.
    expires: overrides.expires ?? Date.now() + 10 * 60_000,
  }
}

async function getLoaderFetch(readAuth: () => Promise<unknown>) {
  const { hooks, writes } = await getHooks()
  const res = await hooks.auth!.loader!(readAuth as any, {} as any)
  return { fetch: (res as { fetch: typeof fetch }).fetch, apiKey: (res as { apiKey: string }).apiKey, writes }
}

test("auth.loader: refuses to run when no credentials are persisted", async () => {
  const { fetch: f } = await getLoaderFetch(async () => undefined)
  await expect(f("https://api.kimi.com/coding/v1/models")).rejects.toThrow(/not logged in/)
})

test("auth.loader: apiKey sentinel is returned (opencode requires truthy)", async () => {
  const { apiKey } = await getLoaderFetch(async () => validAuth())
  expect(apiKey).toBe("kimi-for-coding-oauth")
})

test("auth.loader: owns Authorization and strips any caller-supplied value (rule 3)", async () => {
  mock = installFetchMock(() => ({ body: { ok: true } }))
  const { fetch: f } = await getLoaderFetch(async () => validAuth({ access: jwt() }))
  await f("https://api.kimi.com/coding/v1/chat", {
    method: "POST",
    headers: { Authorization: "Bearer SHOULD-BE-OVERRIDDEN", authorization: "lower-also" },
    body: JSON.stringify({}),
  })
  expect(mock.calls).toHaveLength(1)
  const h = mock.calls[0]!.headers
  expect(h["authorization"]).toBe(`Bearer ${jwt()}`)
  // Seven kimi-cli fingerprint headers are attached on every request.
  expect(h["x-msh-platform"]).toBe("kimi_cli")
  expect(h["x-msh-version"]).toBeDefined()
  expect(h["x-msh-device-id"]).toMatch(/^[0-9a-f]{32}$/)
})

test("auth.loader: refreshes when expiry is within safety window", async () => {
  let reads = 0
  const initial = validAuth({ expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2 })
  let current: ReturnType<typeof validAuth> = initial
  const readAuth = async () => {
    reads++
    return current
  }
  // Expected order: token refresh → /models discovery → actual request.
  mock = installFetchMock((call) => {
    if (call.url.includes("/oauth/token")) {
      return { body: { access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: "kimi-for-coding", display_name: "Kimi Code", context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f, writes } = await getLoaderFetch(readAuth)
  await f("https://api.kimi.com/coding/v1/chat")
  expect(mock.calls.map((c) => c.url)).toEqual([
    "https://auth.kimi.com/api/oauth/token",
    "https://api.kimi.com/coding/v1/models",
    "https://api.kimi.com/coding/v1/chat",
  ])
  expect(mock.calls[2]!.headers["authorization"]).toBe("Bearer access-2")
  // Persisted the refreshed token + discovered model metadata.
  expect(writes).toHaveLength(1)
  expect(writes[0]!.id).toBe(PROVIDER_ID)
  const persisted = writes[0]!.body as { access: string; model_id?: string; context_length?: number }
  expect(persisted.access).toBe("access-2")
  expect(persisted.model_id).toBe("kimi-for-coding")
  expect(persisted.context_length).toBe(262144)
  expect(reads).toBeGreaterThan(0)
})

test("auth.loader: model discovery failure does not break refresh (graceful)", async () => {
  const current = validAuth({ expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2, access: "old" })
  mock = installFetchMock((call) => {
    if (call.url.includes("/oauth/token")) {
      return { body: { access_token: "new", refresh_token: "r", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models")) return { status: 500, body: { error: "oops" } }
    return { body: { ok: true } }
  })
  const { fetch: f, writes } = await getLoaderFetch(async () => current)
  const res = await f("https://api.kimi.com/coding/v1/chat")
  expect(res.ok).toBe(true)
  // Persisted despite /models failing; just no model_id.
  expect((writes[0]!.body as { access: string }).access).toBe("new")
  expect((writes[0]!.body as { model_id?: string }).model_id).toBeUndefined()
})

test("auth.loader: rewrites wire `model` to the discovered server id (Option A)", async () => {
  // Persisted auth already carries a discovered model_id different from the
  // opencode-side MODEL_ID placeholder — this is the K2.5 account case.
  const current = {
    ...validAuth(),
    model_id: "k2p5",
  } as unknown as ReturnType<typeof validAuth>
  mock = installFetchMock(() => ({ body: { ok: true } }))
  const { fetch: f } = await getLoaderFetch(async () => current)
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  expect(mock.calls).toHaveLength(1)
  const sentBody = JSON.parse(mock.calls[0]!.body as string)
  expect(sentBody.model).toBe("k2p5")
  expect(sentBody.messages).toEqual([])
})

test("auth.loader: leaves body untouched when discovered id equals MODEL_ID (K2.6 case)", async () => {
  const current = { ...validAuth(), model_id: MODEL_ID } as unknown as ReturnType<typeof validAuth>
  mock = installFetchMock(() => ({ body: { ok: true } }))
  const { fetch: f } = await getLoaderFetch(async () => current)
  const originalBody = JSON.stringify({ model: MODEL_ID, x: 1 })
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: originalBody,
  })
  expect(mock.calls[0]!.body).toBe(originalBody)
})

test("auth.loader: 401 triggers exactly one forced refresh + retry (no infinite loop)", async () => {
  let current = validAuth({ access: "stale" })
  const readAuth = async () => current
  mock = installFetchMock((call) => {
    if (call.url.includes("/oauth/token")) {
      current = { ...current, access: "fresh" }
      return { body: { access_token: "fresh", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: "kimi-for-coding", context_length: 262144 }] } }
    }
    // First API call: stale → 401. Every subsequent API call: 401 as well.
    // The loader must NOT loop; exactly one retry after refresh.
    return { status: 401, body: { error: "unauthorized" } }
  })
  const { fetch: f } = await getLoaderFetch(readAuth)
  const res = await f("https://api.kimi.com/coding/v1/chat")
  expect(res.status).toBe(401)
  const urls = mock.calls.map((c) => c.url)
  // Expected order: stale call → refresh → /models discovery → retry with fresh token → STOP.
  expect(urls).toEqual([
    "https://api.kimi.com/coding/v1/chat",
    "https://auth.kimi.com/api/oauth/token",
    "https://api.kimi.com/coding/v1/models",
    "https://api.kimi.com/coding/v1/chat",
  ])
  expect(mock.calls[0]!.headers["authorization"]).toBe("Bearer stale")
  expect(mock.calls[3]!.headers["authorization"]).toBe("Bearer fresh")
})

// ---------- auth.methods (device flow wiring) -------------------------------

test("auth.methods[0].authorize returns URL + instructions + async callback", async () => {
  mock = installFetchMock((call) => {
    if (call.url.includes("device_authorization")) {
      return {
        body: {
          device_code: "dc",
          user_code: "WXYZ-1234",
          verification_uri: "https://auth.kimi.com/device",
          verification_uri_complete: "https://auth.kimi.com/device?u=WXYZ-1234",
          expires_in: 60,
          interval: 1,
        },
      }
    }
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: "kimi-for-coding", display_name: "Kimi Code", context_length: 262144 }] } }
    }
    return { body: { access_token: "A", refresh_token: "R", token_type: "Bearer", expires_in: 900 } }
  })
  const { hooks } = await getHooks()
  const method = hooks.auth!.methods![0] as { authorize: () => Promise<any> }
  const r = await method.authorize()
  expect(r.url).toBe("https://auth.kimi.com/device?u=WXYZ-1234")
  expect(r.instructions).toContain("WXYZ-1234")
  const cb = await r.callback()
  expect(cb.type).toBe("success")
  expect(cb.access).toBe("A")
  expect(cb.refresh).toBe("R")
  expect(typeof cb.expires).toBe("number")
  // Discovered fields are persisted alongside the token (Option A+B).
  expect(cb.model_id).toBe("kimi-for-coding")
  expect(cb.context_length).toBe(262144)
})
