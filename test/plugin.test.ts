import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test, expect, afterEach } from "bun:test"
import plugin from "../src/index.ts"
import { MODEL_ID, PROVIDER_ID, REFRESH_SAFETY_WINDOW_MS } from "../src/constants.ts"
import { installFetchMock } from "./_util/fetchMock.ts"

// kimiHeaders() → getDeviceId() reads/writes ~/.kimi/device_id; that file is
// shared with kimi-cli by design and writes are idempotent — no HOME
// redirect needed.

const TEST_XDG_DATA_HOME = path.join(os.tmpdir(), `opencode-kimi-full-test-${process.pid}`)
process.env.XDG_DATA_HOME = TEST_XDG_DATA_HOME
delete process.env.OPENCODE_AUTH_CONTENT

let mock: ReturnType<typeof installFetchMock> | undefined
afterEach(async () => {
  mock?.restore()
  mock = undefined
  process.env.XDG_DATA_HOME = TEST_XDG_DATA_HOME
  delete process.env.OPENCODE_AUTH_CONTENT
  await fs.rm(TEST_XDG_DATA_HOME, { recursive: true, force: true })
})

async function withTempAuthStore<T>(entry: unknown, run: (root: string) => Promise<T>) {
  const prev = process.env.XDG_DATA_HOME
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-kimi-full-"))
  process.env.XDG_DATA_HOME = root
  await writeAuthStore(root, entry)
  try {
    return await run(root)
  } finally {
    if (prev === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = prev
    }
    await fs.rm(root, { recursive: true, force: true })
  }
}

function authStorePath(root: string) {
  return path.join(root, "opencode", "auth.json")
}

async function writeAuthStore(root: string, entry: unknown) {
  await fs.mkdir(path.dirname(authStorePath(root)), { recursive: true })
  await fs.writeFile(authStorePath(root), JSON.stringify({ [PROVIDER_ID]: entry }), "utf8")
}

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

// ---------- chat hooks ------------------------------------------------------

const INTERNAL_PROMPT_CACHE_KEY_HEADER = "x-opencode-kimi-prompt-cache-key"
const INTERNAL_REASONING_EFFORT_HEADER = "x-opencode-kimi-reasoning-effort"
const INTERNAL_THINKING_TYPE_HEADER = "x-opencode-kimi-thinking-type"

type Hooks = Awaited<ReturnType<typeof plugin>>
type ChatParamsHook = NonNullable<Hooks["chat.params"]>
type ChatHeadersHook = NonNullable<Hooks["chat.headers"]>
type ParamsOutput = Parameters<ChatParamsHook>[1]
type HeadersOutput = Parameters<ChatHeadersHook>[1]

type HookInputOptions = {
  providerID?: string
  modelID?: string
  sessionID?: string
  modelOptions?: Record<string, unknown>
  variants?: Record<string, Record<string, unknown>>
  variant?: string
}

function makeHookInput(options: HookInputOptions = {}) {
  const providerID = options.providerID ?? PROVIDER_ID
  return {
    agent: "test-agent",
    provider: { id: providerID },
    model: {
      providerID,
      id: options.modelID ?? MODEL_ID,
      options: options.modelOptions,
      variants: options.variants,
    },
    message: {
      model: {
        variant: options.variant,
      },
    },
    sessionID: options.sessionID ?? "sess-1",
  }
}

async function callParams(
  hook: ChatParamsHook,
  input: HookInputOptions = {},
  options: Record<string, unknown> = {},
) {
  const output: ParamsOutput = {
    temperature: 0,
    topP: 1,
    topK: 0,
    maxOutputTokens: undefined,
    options: { ...options },
  }
  await hook(makeHookInput(input) as any, output)
  return { output }
}

async function callHeaders(hook: ChatHeadersHook, input: HookInputOptions = {}) {
  const output: HeadersOutput = { headers: {} }
  await hook(makeHookInput(input) as any, output)
  return { output }
}

test("chat.params: no-op for other providers (AGENTS.md rule: gated on PROVIDER_ID)", async () => {
  const { hooks } = await getHooks()
  const hook = hooks["chat.params"]!
  const { output } = await callParams(
    hook,
    { providerID: "some-other-provider", modelOptions: { reasoning_effort: "high" } },
    { reasoning_effort: "high" },
  )
  // Untouched — no prompt_cache_key, no thinking added.
  expect(output.options).toEqual({ reasoning_effort: "high" })
})

test("chat.params: no-op for other models under our provider (rule 5 gating)", async () => {
  const { hooks } = await getHooks()
  const hook = hooks["chat.params"]!
  const { output } = await callParams(hook, { modelID: "kimi-something-else" })
  expect(output.options.prompt_cache_key).toBeUndefined()
  expect(output.options.thinking).toBeUndefined()
})

test("chat.params: attaches prompt_cache_key = sessionID for kimi-for-coding only", async () => {
  const { hooks } = await getHooks()
  const hook = hooks["chat.params"]!
  const { output } = await callParams(hook, { sessionID: "sess-42" })
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
  const { output } = await callParams(
    hooks["chat.params"]!,
    { modelOptions: { reasoning_effort: "auto" } },
    { reasoning_effort: "auto" },
  )
  expect(output.options.reasoning_effort).toBeUndefined()
  expect(output.options.reasoningEffort).toBeUndefined()
  expect(output.options.thinking).toBeUndefined()
})
for (const row of EFFORT_MATRIX) {
  test(`chat.params: effort=${JSON.stringify(row.in)} → effort=${row.effort}, thinking=${row.thinkingType}`, async () => {
    const { hooks } = await getHooks()
    const { output } = await callParams(hooks["chat.params"]!, { modelOptions: row.in }, row.in)
    expect(output.options.reasoning_effort).toBe(row.effort)
    expect(output.options.thinking).toEqual({ type: row.thinkingType })
  })
}

test("chat.params: `reasoningEffort` (camelCase) input also drives the mapping", async () => {
  // opencode may use camelCase upstream; the plugin accepts either.
  const { hooks } = await getHooks()
  const { output } = await callParams(
    hooks["chat.params"]!,
    { modelOptions: { reasoningEffort: "off" } },
    { reasoningEffort: "off" },
  )
  expect(output.options.thinking).toEqual({ type: "disabled" })
  expect(output.options.reasoning_effort).toBeUndefined()
  expect(output.options.reasoningEffort).toBeUndefined()
})

test("chat.headers: default request enables thinking and carries prompt_cache_key", async () => {
  const { hooks } = await getHooks()
  const { output } = await callHeaders(hooks["chat.headers"]!)
  expect(output.headers[INTERNAL_PROMPT_CACHE_KEY_HEADER]).toBe("sess-1")
  expect(output.headers[INTERNAL_THINKING_TYPE_HEADER]).toBe("enabled")
  expect(output.headers[INTERNAL_REASONING_EFFORT_HEADER]).toBeUndefined()
})

test("chat.headers: selected variant overrides model options for the wire effort mapping", async () => {
  const { hooks } = await getHooks()
  const { output } = await callHeaders(hooks["chat.headers"]!, {
    modelOptions: { reasoning_effort: "high" },
    variants: {
      auto: { reasoning_effort: "auto" },
      off: { reasoning_effort: "off" },
      low: { reasoning_effort: "low" },
    },
    variant: "off",
  })
  expect(output.headers[INTERNAL_PROMPT_CACHE_KEY_HEADER]).toBe("sess-1")
  expect(output.headers[INTERNAL_THINKING_TYPE_HEADER]).toBe("disabled")
  expect(output.headers[INTERNAL_REASONING_EFFORT_HEADER]).toBeUndefined()
})

test("chat.headers: effort=auto omits both thinking and reasoning_effort", async () => {
  const { hooks } = await getHooks()
  const { output } = await callHeaders(hooks["chat.headers"]!, {
    variants: { auto: { reasoning_effort: "auto" } },
    variant: "auto",
  })
  expect(output.headers[INTERNAL_PROMPT_CACHE_KEY_HEADER]).toBe("sess-1")
  expect(output.headers[INTERNAL_THINKING_TYPE_HEADER]).toBeUndefined()
  expect(output.headers[INTERNAL_REASONING_EFFORT_HEADER]).toBeUndefined()
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeProviderState(context = 0) {
  return {
    id: PROVIDER_ID,
    models: {
      [MODEL_ID]: {
        name: "Kimi For Coding",
        reasoning: true,
        options: {},
        limit: { context },
        variants: {
          auto: { reasoning_effort: "auto" },
        },
      },
      "some-other-model": {
        name: "Other",
        reasoning: false,
        options: {},
        limit: { context: 1234 },
      },
    },
  }
}

// ---------- provider.models -------------------------------------------------

test("provider.models: fills limit.context from discovery when config still has zero", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { hooks, writes } = await getHooks()
  const provider = makeProviderState()
  const next = await hooks.provider!.models!(provider as any, { auth: validAuth() } as any)
  expect(mock.calls[0]!.hasSignal).toBe(true)
  expect(next[MODEL_ID]!.limit?.context).toBe(262144)
  expect(next["some-other-model"]!.limit?.context).toBe(1234)
  expect(provider.models[MODEL_ID]!.limit?.context).toBe(0)
  expect(writes).toHaveLength(0)
})

test("provider.models: surfaces discovered display_name in runtime model metadata", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, display_name: "Kimi Code", context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { hooks } = await getHooks()
  const provider = makeProviderState()
  const next = await hooks.provider!.models!(provider as any, { auth: validAuth() } as any)
  expect(next[MODEL_ID]!.name).toBe("Kimi Code")
  expect(provider.models[MODEL_ID]!.name).toBe("Kimi For Coding")
})

test("provider.models: preserves an explicit user context limit", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { hooks } = await getHooks()
  const provider = makeProviderState(8192)
  const next = await hooks.provider!.models!(provider as any, { auth: validAuth() } as any)
  expect(next[MODEL_ID]!.limit?.context).toBe(8192)
})

test("provider.models: retries once with a refreshed token after 401", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models") && call.headers["authorization"] === "Bearer stale") {
      return { status: 401, body: { error: "unauthorized" } }
    }
    if (call.url.includes("/oauth/token")) {
      return { body: { access_token: "fresh", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models") && call.headers["authorization"] === "Bearer fresh") {
      return { body: { data: [{ id: MODEL_ID, context_length: 131072 }] } }
    }
    return { body: { ok: true } }
  })
  const { hooks, writes } = await getHooks()
  const provider = makeProviderState()
  const next = await hooks.provider!.models!(provider as any, { auth: validAuth({ access: "stale" }) } as any)
  expect(mock.calls.map((c) => c.url)).toEqual([
    "https://api.kimi.com/coding/v1/models",
    "https://auth.kimi.com/api/oauth/token",
    "https://api.kimi.com/coding/v1/models",
  ])
  expect(mock.calls[2]!.headers["authorization"]).toBe("Bearer fresh")
  expect(next[MODEL_ID]!.limit?.context).toBe(131072)
  expect((writes[0]!.body as { access: string }).access).toBe("fresh")
})

test("provider.models: prefers the live auth store over a stale ctx.auth snapshot", async () => {
  await withTempAuthStore(validAuth({ access: "fresh", refresh: "refresh-2" }), async () => {
    mock = installFetchMock((call) => {
      if (call.url.endsWith("/coding/v1/models") && call.headers["authorization"] === "Bearer fresh") {
        return { body: { data: [{ id: MODEL_ID, context_length: 131072 }] } }
      }
      return { status: 401, body: { error: "unauthorized" } }
    })
    const { hooks } = await getHooks()
    const provider = makeProviderState()
    const next = await hooks.provider!.models!(
      provider as any,
      { auth: validAuth({ access: "stale", refresh: "refresh-1" }) } as any,
    )
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0]!.headers["authorization"]).toBe("Bearer fresh")
    expect(next[MODEL_ID]!.limit?.context).toBe(131072)
  })
})

test("auth.loader: refuses to run when no credentials are persisted", async () => {
  const { fetch: f } = await getLoaderFetch(async () => undefined)
  await expect(f("https://api.kimi.com/coding/v1/models")).rejects.toThrow(/not logged in/)
})

test("auth.loader: apiKey sentinel is returned (opencode requires truthy)", async () => {
  const { apiKey } = await getLoaderFetch(async () => validAuth())
  expect(apiKey).toBe("kimi-for-coding-oauth")
})

test("auth.loader: prefers live auth.json over a stale readAuth snapshot", async () => {
  await withTempAuthStore(validAuth({ access: "fresh", refresh: "refresh-2" }), async () => {
    mock = installFetchMock((call) => {
      if (call.url.endsWith("/coding/v1/models")) {
        return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
      }
      return { body: { ok: true } }
    })
    const { fetch: f } = await getLoaderFetch(async () => validAuth({ access: "stale", refresh: "refresh-1" }))
    await f("https://api.kimi.com/coding/v1/chat")
    expect(mock.calls.map((c) => c.url)).toEqual([
      "https://api.kimi.com/coding/v1/models",
      "https://api.kimi.com/coding/v1/chat",
    ])
    expect(mock.calls[0]!.headers["authorization"]).toBe("Bearer fresh")
    expect(mock.calls[1]!.headers["authorization"]).toBe("Bearer fresh")
  })
})

test("auth.loader: owns Authorization and strips any caller-supplied value (rule 3)", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth({ access: jwt() }))
  await f("https://api.kimi.com/coding/v1/chat", {
    method: "POST",
    headers: { Authorization: "Bearer SHOULD-BE-OVERRIDDEN", authorization: "lower-also" },
    body: JSON.stringify({}),
  })
  expect(mock.calls.map((c) => c.url)).toEqual([
    "https://api.kimi.com/coding/v1/models",
    "https://api.kimi.com/coding/v1/chat",
  ])
  const h = mock.calls[1]!.headers
  expect(h["authorization"]).toBe(`Bearer ${jwt()}`)
  // Seven kimi-cli fingerprint headers are attached on every request.
  expect(h["x-msh-platform"]).toBe("kimi_cli")
  expect(h["x-msh-version"]).toBeDefined()
  expect(h["x-msh-device-id"]).toMatch(/^[0-9a-f]{32}$/)
})

test("auth.loader: injects default thinking via private headers and strips them upstream", async () => {
  const { hooks } = await getHooks()
  const { output: headerOutput } = await callHeaders(hooks["chat.headers"]!, {
    sessionID: "sess-default",
  })
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headerOutput.headers,
    },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  const upstream = mock.calls[1]!
  expect(upstream.headers[INTERNAL_PROMPT_CACHE_KEY_HEADER]).toBeUndefined()
  expect(upstream.headers[INTERNAL_REASONING_EFFORT_HEADER]).toBeUndefined()
  expect(upstream.headers[INTERNAL_THINKING_TYPE_HEADER]).toBeUndefined()
  expect(JSON.parse(upstream.body as string)).toEqual({
    model: MODEL_ID,
    messages: [],
    prompt_cache_key: "sess-default",
    thinking: { type: "enabled" },
  })
})

test("auth.loader: injects selected reasoning_effort from private headers into the wire body", async () => {
  const { hooks } = await getHooks()
  const { output: headerOutput } = await callHeaders(hooks["chat.headers"]!, {
    sessionID: "sess-high",
    variants: { high: { reasoning_effort: "high" } },
    variant: "high",
  })
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headerOutput.headers,
    },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  expect(JSON.parse(mock.calls[1]!.body as string)).toEqual({
    model: MODEL_ID,
    messages: [],
    prompt_cache_key: "sess-high",
    reasoning_effort: "high",
    thinking: { type: "enabled" },
  })
})

test("auth.loader: effort=auto injects only prompt_cache_key and never synthesizes temperature", async () => {
  const { hooks } = await getHooks()
  const { output: headerOutput } = await callHeaders(hooks["chat.headers"]!, {
    sessionID: "sess-auto",
    variants: { auto: { reasoning_effort: "auto" } },
    variant: "auto",
  })
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headerOutput.headers,
    },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  expect(JSON.parse(mock.calls[1]!.body as string)).toEqual({
    model: MODEL_ID,
    messages: [],
    prompt_cache_key: "sess-auto",
  })
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
  // opencode's SDK auth schema persists only the standard oauth fields; model
  // discovery is cached in-memory by the loader.
  expect(persisted.model_id).toBeUndefined()
  expect(persisted.context_length).toBeUndefined()
  expect(reads).toBeGreaterThan(0)
})

test("auth.loader: concurrent expiring requests share one refresh exchange", async () => {
  const gate = deferred<void>()
  mock = installFetchMock(async (call) => {
    if (call.url.includes("/oauth/token")) {
      await gate.promise
      return { body: { access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const expiring = validAuth({ access: "stale", expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2 })
  const { fetch: f, writes } = await getLoaderFetch(async () => expiring)
  const request = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  }

  const p1 = f("https://api.kimi.com/coding/v1/chat/completions", request)
  const p2 = f("https://api.kimi.com/coding/v1/chat/completions", request)
  await new Promise((r) => setTimeout(r, 0))
  gate.resolve()
  await Promise.all([p1, p2])

  expect(mock.calls.filter((c) => c.url.includes("/oauth/token"))).toHaveLength(1)
  expect(mock.calls.filter((c) => c.url.endsWith("/coding/v1/chat/completions"))).toHaveLength(2)
  expect(mock.calls.filter((c) => c.url.endsWith("/coding/v1/chat/completions")).map((c) => c.headers["authorization"])).toEqual([
    "Bearer access-2",
    "Bearer access-2",
  ])
  expect(writes).toHaveLength(1)
})

test("provider.models and auth.loader share one in-flight refresh exchange", async () => {
  const gate = deferred<void>()
  mock = installFetchMock(async (call) => {
    if (call.url.includes("/oauth/token")) {
      await gate.promise
      return { body: { access_token: "fresh", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 131072 }] } }
    }
    return { body: { ok: true } }
  })
  const { hooks, writes } = await getHooks()
  const expiring = validAuth({ access: "stale", expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2 })
  const provider = makeProviderState()
  const loader = (await hooks.auth!.loader!(async () => expiring, {} as any)) as { fetch: typeof fetch }

  const modelsPromise = hooks.provider!.models!(provider as any, { auth: expiring } as any)
  const fetchPromise = loader.fetch("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  await new Promise((r) => setTimeout(r, 0))
  gate.resolve()
  const [models] = await Promise.all([modelsPromise, fetchPromise])

  expect(mock.calls.filter((c) => c.url.includes("/oauth/token"))).toHaveLength(1)
  expect((models as Record<string, { limit?: { context?: number } }>)[MODEL_ID]!.limit?.context).toBe(131072)
  expect(writes).toHaveLength(1)
})

test("auth.loader: separate plugin instances share one refresh via the auth-store lock", async () => {
  const stale = validAuth({ access: "stale", expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2 })
  await withTempAuthStore(stale, async (root) => {
    const gate = deferred<void>()
    mock = installFetchMock(async (call) => {
      if (call.url.includes("/oauth/token")) {
        await gate.promise
        const next = validAuth({ access: "access-2", refresh: "refresh-2", expires: Date.now() + 15 * 60_000 })
        await writeAuthStore(root, next)
        return { body: { access_token: next.access, refresh_token: next.refresh, token_type: "Bearer", expires_in: 900 } }
      }
      if (call.url.endsWith("/coding/v1/models")) {
        return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
      }
      return { body: { ok: true } }
    })
    const readAuth = async () => stale
    const { fetch: f1 } = await getLoaderFetch(readAuth)
    const { fetch: f2 } = await getLoaderFetch(readAuth)
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL_ID, messages: [] }),
    }

    const p1 = f1("https://api.kimi.com/coding/v1/chat/completions", request)
    const p2 = f2("https://api.kimi.com/coding/v1/chat/completions", request)
    await new Promise((r) => setTimeout(r, 0))
    gate.resolve()
    await Promise.all([p1, p2])

    expect(mock.calls.filter((c) => c.url.includes("/oauth/token"))).toHaveLength(1)
    expect(mock.calls.filter((c) => c.url.endsWith("/coding/v1/chat/completions")).map((c) => c.headers["authorization"])).toEqual([
      "Bearer access-2",
      "Bearer access-2",
    ])
  })
})

test("auth.loader: prefers the canonical MODEL_ID slug when /models returns multiple", async () => {
  // Server returns several entries; the canonical `kimi-for-coding` is not first.
  // Selection must still prefer it over the first element.
  const current = validAuth({ expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2 })
  mock = installFetchMock((call) => {
    if (call.url.includes("/oauth/token")) {
      return { body: { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models")) {
      return {
        body: {
          data: [
            { id: "some-other-slug", context_length: 100000 },
            { id: MODEL_ID, context_length: 262144, display_name: "Kimi" },
          ],
        },
      }
    }
    return { body: { ok: true } }
  })
  const { writes, fetch: f } = await getLoaderFetch(async () => current)
  await f("https://api.kimi.com/coding/v1/chat")
  const persisted = writes[0]!.body as { model_id?: string; context_length?: number }
  expect(persisted.model_id).toBeUndefined()
  expect(persisted.context_length).toBeUndefined()
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

test("auth.loader: invalid_grant self-heals when the live auth store rotated mid-refresh", async () => {
  const stale = validAuth({ access: "stale", expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2 })
  await withTempAuthStore(stale, async (root) => {
    mock = installFetchMock(async (call) => {
      if (call.url.includes("/oauth/token")) {
        const next = validAuth({ access: "fresh", refresh: "refresh-2", expires: Date.now() + 15 * 60_000 })
        await writeAuthStore(root, next)
        return {
          status: 400,
          body: { error: "invalid_grant", error_description: "The provided authorization grant is invalid" },
        }
      }
      if (call.url.endsWith("/coding/v1/models")) {
        return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
      }
      return { body: { ok: true } }
    })
    const { fetch: f, writes } = await getLoaderFetch(async () => stale)
    const res = await f("https://api.kimi.com/coding/v1/chat")
    expect(res.ok).toBe(true)
    expect(mock.calls.map((c) => c.url)).toEqual([
      "https://auth.kimi.com/api/oauth/token",
      "https://api.kimi.com/coding/v1/models",
      "https://api.kimi.com/coding/v1/chat",
    ])
    expect(mock.calls[1]!.headers["authorization"]).toBe("Bearer fresh")
    expect(mock.calls[2]!.headers["authorization"]).toBe("Bearer fresh")
    expect(writes).toHaveLength(0)
  })
})

test("auth.loader: discovers /models on first request when auth storage only has bare oauth fields", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: "k2p5", display_name: "Kimi Code", context_length: 131072 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  expect(mock.calls.map((c) => c.url)).toEqual([
    "https://api.kimi.com/coding/v1/models",
    "https://api.kimi.com/coding/v1/chat/completions",
  ])
  const sentBody = JSON.parse(mock.calls[1]!.body as string)
  expect(sentBody.model).toBe("k2p5")
})

test("auth.loader: caches discovered model info for subsequent requests in the same loader", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: "k2p5", display_name: "Kimi Code", context_length: 131072 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, turn: 1 }),
  })
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, turn: 2 }),
  })
  expect(mock.calls.filter((c) => c.url.endsWith("/coding/v1/models"))).toHaveLength(1)
})

test("auth.loader: rewrites wire `model` to the discovered server id (Option A)", async () => {
  // Persisted auth already carries a discovered model_id different from the
  // opencode-side MODEL_ID placeholder — this is the alternate-slug case.
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

test("auth.loader: leaves body untouched when discovered id equals MODEL_ID", async () => {
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

test("auth.loader: preserves Request input headers while still rewriting Authorization and model", async () => {
  mock = installFetchMock(() => ({ body: { ok: true } }))
  const { fetch: f } = await getLoaderFetch(
    async () =>
      ({
        ...validAuth(),
        model_id: "k2p5",
      }) as unknown as ReturnType<typeof validAuth>,
  )
  const req = new Request("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-extra": "keep-me",
      Authorization: "Bearer stale",
    },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  await f(req)
  expect(mock.calls[0]!.headers["x-extra"]).toBe("keep-me")
  expect(mock.calls[0]!.headers["authorization"]).toBe("Bearer access-1")
  expect(JSON.parse(mock.calls[0]!.body as string).model).toBe("k2p5")
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
  // Expected order: startup discovery with stale token → stale call → refresh
  // → /models discovery with fresh token → retry with fresh token → STOP.
  expect(urls).toEqual([
    "https://api.kimi.com/coding/v1/models",
    "https://api.kimi.com/coding/v1/chat",
    "https://auth.kimi.com/api/oauth/token",
    "https://api.kimi.com/coding/v1/models",
    "https://api.kimi.com/coding/v1/chat",
  ])
  expect(mock.calls[1]!.headers["authorization"]).toBe("Bearer stale")
  expect(mock.calls[4]!.headers["authorization"]).toBe("Bearer fresh")
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
})

test("auth callback prints a schema-valid config snippet with top-level model variants", async () => {
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
  const lines: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  }
  try {
    await r.callback()
  } finally {
    console.log = orig
  }

  const text = lines.join("\n")
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    provider: {
      [key: string]: {
        models: {
          [key: string]: {
            limit?: { context?: number }
            options?: Record<string, unknown>
            variants?: Record<string, { reasoning_effort?: string }>
          }
        }
      }
    }
  }
  const model = parsed.provider[PROVIDER_ID]!.models[MODEL_ID]!
  expect(text).toContain("context 262144")
  expect(model.limit).toBeUndefined()
  expect(model.options).toEqual({})
  expect(model.variants?.off).toEqual({ reasoning_effort: "off" })
  expect(model.variants?.auto).toEqual({ reasoning_effort: "auto" })
  expect(model.options?.variants).toBeUndefined()
})
