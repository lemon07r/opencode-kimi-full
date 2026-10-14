import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { isAuthExpiring, refreshAuthWithLock } from "./auth-refresh.ts"
import { isOAuthAuth, readAuth, type OAuthAuth } from "./auth-store.ts"
import { readDiscoveryCache, writeDiscoveryCache } from "./discovery-cache.ts"
import {
  API_BASE_URL,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_OUTPUT_LIMIT,
  MODEL_ID,
  PROVIDER_ID,
} from "./constants.ts"
import { kimiHeaders } from "./headers.ts"
import { type KimiModelInfo, listModels, pollDeviceToken, startDeviceAuth } from "./oauth.ts"

// IMPORTANT: this module must have exactly ONE export — the default
// PluginModule object. opencode's plugin loader detects the v1 format
// ({ id, server }) via readV1Plugin *before* falling back to
// getLegacyPlugins — which iterates every export and throws "Plugin export
// is not a function" on any non-callable value. The v1 path is more
// reliable on Windows where Bun standalone dynamic imports can produce
// module namespace objects with unexpected non-function metadata.
// Keep constants in constants.ts and import them here.

type ModelDiscovery = {
  models?: KimiModelInfo[]
}

// Per-model metadata extracted from the discovery response for the loader's
// wire model rewriting and the printed config hint.
type SingleModelDiscovery = {
  model_id?: string
  context_length?: number
  model_display?: string
  supports_image_in?: boolean
  supports_video_in?: boolean
}

type ThinkingType = "enabled" | "disabled"

type KimiBodyFields = {
  prompt_cache_key?: string
  thinking?: { type: ThinkingType }
  reasoning_effort?: string
}

type ModelWithDiscoveryMetadata = {
  name?: string
  attachment?: boolean
  reasoning?: boolean
  variants?: Record<string, Record<string, unknown>>
  limit?: {
    context?: number
  }
  modalities?: {
    input?: string[]
    output?: string[]
  }
  capabilities?: {
    attachment?: boolean
    reasoning?: boolean
    input?: {
      image?: boolean
    }
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
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
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

// --- WYSIWYG model naming ---------------------------------------------------
//
// Identity contract: the model key a user sees in the opencode picker is
// exactly the string they reference from agent files and opencode.json
// (`kimi-for-coding-oauth/<key>`). Keys are derived from the server's
// `display_name`; the raw server slug travels on the wire separately via the
// per-model `api.id` (opencode resolves wire ids through `model.api.id`, and
// config-defined models accept an explicit `id` field for the same purpose).
// The loader's fetch rewrite remains as a safety net for direct SDK callers.

function displayNameKey(model: { id: string; display_name?: string }): string {
  const name = model.display_name?.trim()
  return name || model.id
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase()
}

// Assign stable user-facing keys, preserving server order. On a display-name
// collision (two models advertising the same name) the loser falls back to its
// raw id so every entry stays addressable.
function keyedModels(models: ReadonlyArray<KimiModelInfo>): Array<{ key: string; model: KimiModelInfo }> {
  const used = new Set<string>()
  return models.map((model) => {
    let key = displayNameKey(model)
    if (used.has(key)) key = model.id
    used.add(key)
    return { key, model }
  })
}

// Resolve a requested model reference (config key, raw server id, or a
// case/whitespace variant of either) to its server discovery entry.
function findDiscovered(
  requested: string | undefined,
  models: ReadonlyArray<KimiModelInfo> | undefined,
): KimiModelInfo | undefined {
  if (!requested || !models?.length) return undefined
  const byId = models.find((m) => m.id === requested)
  if (byId) return byId
  const byKey = models.find((m) => displayNameKey(m) === requested)
  if (byKey) return byKey
  const target = normalizeKey(requested)
  if (!target) return undefined
  return models.find((m) => normalizeKey(m.id) === target || normalizeKey(displayNameKey(m)) === target)
}


// Effort tiers are server-driven: `think_efforts.valid_efforts` in the
// discovery payload is the authoritative capability statement (kimi-cli
// predates this field and clamps max→high for K2.7; models that carry the
// field — e.g. k3, k3-256k — advertise `max` explicitly). When the server
// says nothing, clamp conservatively: an unsupported effort value fails the
// request upstream, so a silent downgrade is the only safe default.
function clampEffort(effort: string, info: KimiModelInfo | undefined): string | undefined {
  let result = effort
  if (result === "xhigh") result = "high"
  if (result === "max" && !info?.think_efforts?.valid_efforts?.includes("max")) result = "high"
  // When the server enumerates its tiers they are authoritative: an effort it
  // did not advertise would fail the request upstream, so it is omitted and
  // the server applies its advertised default_effort instead.
  const valid = info?.think_efforts?.valid_efforts
  if (valid?.length && result !== "auto" && result !== "off" && !valid.includes(result)) return undefined
  return result
}

// The catalog the chat hooks gate on: the server-discovered list once
// discovery has succeeded in this process (kimi-cli keeps no static list at
// all — removed/entitled-out models drop out, so their requests fail loud
// server-side instead of carrying Kimi-specific fields), seeded from the
// last-known-good cache on cold starts. Empty until then.
function resolveKimiBodyFields(
  input: KimiHookInput,
  catalog: ReadonlyArray<KimiModelInfo>,
): KimiBodyFields | undefined {
  if (input.model.providerID !== PROVIDER_ID) return
  const info = findDiscovered(input.model.id, catalog)
  // Unknown references stay ungated so entitlement mistakes surface from the
  // server instead of being silently decorated with Kimi-specific fields.
  // MODEL_ID remains accepted as the legacy wire placeholder.
  if (!info && input.model.id !== MODEL_ID) return

  const modelOptions = asRecord(input.model.options)
  const variantOptions = input.message.model.variant
    ? asRecord(input.model.variants?.[input.message.model.variant])
    : undefined

  const fields: KimiBodyFields = { prompt_cache_key: input.sessionID }
  // A model the server marked non-reasoning must not receive thinking or
  // reasoning_effort — upstream rejects them (kimi-cli gates its "thinking"
  // capability on the same supports_reasoning flag). prompt_cache_key stays:
  // it is a cache hint, not a reasoning control.
  if (info?.supports_reasoning === false) return fields
  const thinking = asThinking(variantOptions?.thinking) ?? asThinking(modelOptions?.thinking)
  const rawEffort = pickEffort(variantOptions) ?? pickEffort(modelOptions)
  // Capability checks use the discovery entry itself (server-advertised
  // tiers), never the user-facing key or a client-side model table.
  const effort = rawEffort ? clampEffort(rawEffort, info) : undefined

  // supports_thinking_type: "only" — thinking is mandatory for these models
  // (all current Kimi Code models advertise it). Never send "disabled", and
  // never leave thinking implicit: a user who forgets to pick a variant (or
  // picks off/auto) still gets thinking enabled; the server applies its
  // advertised default_effort.
  if (info?.supports_thinking_type === "only") {
    fields.thinking = { type: "enabled" }
    if (effort && effort !== "off" && effort !== "auto") fields.reasoning_effort = effort
    return fields
  }

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

const REASONING_VARIANT_KEYS = new Set(["reasoning_effort", "reasoningEffort", "thinking"])

function withDiscoveredReasoning<T extends ModelWithDiscoveryMetadata>(model: T, supportsReasoning: boolean | undefined): T {
  // The server is authoritative about a NEGATIVE capability: a runtime entry
  // that keeps advertising reasoning (capabilities.reasoning + effort
  // variants in the picker) for a model the server calls non-reasoning
  // misleads the UI, even though the request gate strips thinking fields.
  // Only reasoning-specific variant keys are stripped — user variants with
  // other options (e.g. temperature) survive. A positive or absent flag
  // never overrides the user.
  if (supportsReasoning !== false) return model
  const hasReasoning = model.capabilities?.reasoning === true || model.reasoning === true
  const variants = model.variants ?? {}
  const kept: Record<string, Record<string, unknown>> = {}
  let variantsChanged = false
  for (const [name, options] of Object.entries(variants)) {
    const filtered = Object.fromEntries(Object.entries(options ?? {}).filter(([key]) => !REASONING_VARIANT_KEYS.has(key)))
    if (Object.keys(filtered).length === 0) {
      if (Object.keys(options ?? {}).length > 0) variantsChanged = true
      continue
    }
    if (Object.keys(filtered).length !== Object.keys(options ?? {}).length) variantsChanged = true
    kept[name] = filtered
  }
  if (!hasReasoning && !variantsChanged) return model
  return {
    ...model,
    ...(model.reasoning !== undefined ? { reasoning: false } : {}),
    capabilities: { ...model.capabilities, reasoning: false },
    variants: kept,
  }
}

function sameStrings(left: string[] | undefined, right: string[] | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}

function withDiscoveredMediaInput<T extends ModelWithDiscoveryMetadata>(
  model: T,
  supportsImageIn: boolean | undefined,
  supportsVideoIn: boolean | undefined,
): T {
  if (supportsImageIn === undefined && supportsVideoIn === undefined) return model

  let changed = false
  let nextAttachment = model.attachment
  let nextModalities = model.modalities
  let nextCapabilities = model.capabilities

  if (supportsImageIn && model.attachment !== true) {
    nextAttachment = true
    changed = true
  }

  const currentInputModalities = model.modalities?.input
  const currentOutputModalities = model.modalities?.output
  const shouldPatchModalities =
    supportsImageIn || supportsVideoIn ||
    currentInputModalities?.includes("image") === true ||
    currentInputModalities?.includes("video") === true
  if (shouldPatchModalities) {
    const nextInputModalities = uniqueStrings([
      "text",
      ...(currentInputModalities ?? []),
      ...(supportsImageIn ? ["image"] : []),
      ...(supportsVideoIn ? ["video"] : []),
    ])
      .filter((value) => value !== "image" || supportsImageIn)
      .filter((value) => value !== "video" || supportsVideoIn)
    const nextOutputModalities = uniqueStrings(["text", ...(currentOutputModalities ?? [])])
    if (
      !sameStrings(currentInputModalities, nextInputModalities) ||
      !sameStrings(currentOutputModalities, nextOutputModalities)
    ) {
      nextModalities = {
        ...model.modalities,
        input: nextInputModalities,
        output: nextOutputModalities,
      }
      changed = true
    }
  }

  const currentCapabilityImage = model.capabilities?.input?.image
  const currentCapabilityAttachment = model.capabilities?.attachment
  if (currentCapabilityImage !== undefined && currentCapabilityImage !== supportsImageIn) {
    nextCapabilities = {
      ...nextCapabilities,
      input: {
        ...nextCapabilities?.input,
        image: supportsImageIn,
      },
    }
    changed = true
  }
  if (supportsImageIn && currentCapabilityAttachment !== undefined && currentCapabilityAttachment !== true) {
    nextCapabilities = {
      ...nextCapabilities,
      attachment: true,
    }
    changed = true
  }

  if (!changed) return model
  return {
    ...model,
    ...(nextAttachment === undefined ? {} : { attachment: nextAttachment }),
    ...(nextModalities ? { modalities: nextModalities } : {}),
    ...(nextCapabilities ? { capabilities: nextCapabilities } : {}),
  }
}

function prettifyModelId(modelId: string): string {
  return modelId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ")
}

// Server-reported context length wins; otherwise the K2.7-generation default.
// Mirrors kimi-cli, which trusts `context_length` from `/models` unconditionally.
function contextLengthFor(model: { id: string; context_length?: number }): number {
  if (model.context_length && model.context_length > 0) return model.context_length
  return DEFAULT_CONTEXT_LENGTH
}

function effortVariants(info?: Pick<KimiModelInfo, "think_efforts">): Record<string, Record<string, unknown>> {
  const variants: Record<string, Record<string, unknown>> = {
    off: { reasoning_effort: "off" },
    auto: { reasoning_effort: "auto" },
  }
  // The picker's tier ladder is server-driven when the model enumerates its
  // efforts (a static ladder would offer tiers the server rejects — k3, for
  // example, advertises low/high/max and no medium). The static ladder stays
  // only for models that say nothing.
  const tiers = info?.think_efforts?.valid_efforts?.length ? info.think_efforts.valid_efforts : ["low", "medium", "high", "max"]
  for (const tier of tiers) {
    variants[tier] ??= { reasoning_effort: tier }
  }
  return variants
}

// Full runtime model entry for a server-discovered model that is missing from
// the user's config. Shape mirrors what opencode core synthesizes for
// dynamically discovered models (see the gitlab `discoverModels` loader in
// research/opencode/packages/opencode/src/provider/provider.ts).
function buildRuntimeModel(discovered: KimiModelInfo): Record<string, unknown> {
  const supportsImageIn = discovered.supports_image_in ?? true
  const supportsVideoIn = discovered.supports_video_in ?? false
  // kimi-cli derives its "thinking" capability from this exact flag
  // (platforms.py ModelInfo.capabilities) — mirror it.
  const supportsReasoning = discovered.supports_reasoning ?? true
  return {
    api: { id: discovered.id, url: API_BASE_URL, npm: "@ai-sdk/openai-compatible" },
    name: discovered.display_name ?? prettifyModelId(discovered.id),
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: contextLengthFor(discovered), output: DEFAULT_OUTPUT_LIMIT },
    capabilities: {
      temperature: false,
      reasoning: supportsReasoning,
      attachment: supportsImageIn,
      toolcall: true,
      input: { text: true, audio: false, image: supportsImageIn, video: supportsVideoIn, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: supportsReasoning ? effortVariants(discovered) : {},
  }
}

function applyDiscoveryToModels<T extends Record<string, ModelWithDiscoveryMetadata>>(
  models: T,
  discovery: KimiModelInfo[],
): T {
  let changed = false
  const nextModels = { ...models } as T
  // Patch every existing entry that resolves to a discovered model — by
  // user-facing key or raw id, so both pre-v1.6 (raw-id) configs and current
  // display-keyed ones receive fresh metadata.
  for (const [modelId, model] of Object.entries(models)) {
    const discovered = findDiscovered(modelId, discovery)
    if (!discovered) continue
    const next = withDiscoveredMediaInput(
      withDiscoveredContext(
        withDiscoveredDisplayName(withDiscoveredReasoning(model, discovered.supports_reasoning), discovered.display_name),
        discovered.context_length,
      ),
      discovered.supports_image_in,
      discovered.supports_video_in,
    )
    if (next === model) continue
    ;(nextModels as Record<string, ModelWithDiscoveryMetadata>)[modelId] = next
    changed = true
  }
  // kimi-cli's `_apply_models` materializes every server-returned model; do
  // the same under the WYSIWYG key so newly released Kimi Code models appear
  // without a config edit.
  for (const { key, model } of keyedModels(discovery)) {
    if (nextModels[key]) continue
    ;(nextModels as Record<string, unknown>)[key] = buildRuntimeModel(model)
    changed = true
  }
  return changed ? nextModels : models
}

function buildModelConfig(
  name: string,
  contextLength: number,
  supportsImageIn: boolean,
  supportsVideoIn: boolean,
  supportsReasoning = true,
  effortInfo?: Pick<KimiModelInfo, "think_efforts">,
): Record<string, unknown> {
  const modelConfig: Record<string, unknown> = {
    name,
    reasoning: supportsReasoning,
    limit: { context: contextLength, output: DEFAULT_OUTPUT_LIMIT },
    options: {},
    variants: supportsReasoning ? effortVariants(effortInfo) : {},
  }
  if (supportsImageIn) {
    // opencode's provider transform gates image parts on model metadata
    // before the request reaches our loader. Mirror Kimi's discovered
    // capability here so pasted images survive into the upstream SDK.
    modelConfig.attachment = true
    const inputModalities = ["text", "image"]
    if (supportsVideoIn) inputModalities.push("video")
    modelConfig.modalities = {
      input: inputModalities,
      output: ["text"],
    }
  }
  return modelConfig
}

function configModelEntry(model: { id: string; display_name?: string; context_length?: number; supports_image_in?: boolean; supports_video_in?: boolean; supports_reasoning?: boolean; think_efforts?: KimiModelInfo["think_efforts"] }) {
  // Fall back to image=true because all current Kimi Code models support
  // image input; video only when the server explicitly says so. Reasoning
  // follows the server's supports_reasoning flag (kimi-cli parity).
  const entry = buildModelConfig(
    model.display_name ?? prettifyModelId(model.id),
    contextLengthFor(model),
    model.supports_image_in ?? true,
    model.supports_video_in ?? false,
    model.supports_reasoning ?? true,
    model,
  )
  return {
    // The server slug that must travel on the wire. opencode resolves wire
    // ids through this field (`apiID = model.id ?? ... ?? key` in
    // provider.ts), letting the config key be the human-readable name.
    id: model.id,
    ...entry,
  }
}

function buildConfigBlock(models: KimiModelInfo[]) {
  return JSON.stringify(
    {
      provider: {
        [PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Kimi For Coding (OAuth)",
          options: { baseURL: API_BASE_URL },
          models: Object.fromEntries(keyedModels(models).map(({ key, model }) => [key, configModelEntry(model)])),
        },
      },
    },
    null,
    2,
  )
}

type ConfigProviderEntry = {
  npm?: string
  name?: string
  options?: Record<string, unknown>
  models?: Record<string, Record<string, unknown>>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

// User config wins on conflicts; objects merge recursively so a user who
// overrides only `variants.high` keeps the generated `limit`/`modalities`.
function mergeModelConfig(generated: Record<string, unknown>, user: Record<string, unknown>): Record<string, unknown> {
  const out = { ...generated }
  for (const [key, value] of Object.entries(user)) {
    const base = out[key]
    out[key] = isPlainObject(base) && isPlainObject(value) ? mergeModelConfig(base, value) : value
  }
  return out
}

// Fill the provider-level fields any injection path needs before models land.
function ensureProviderEntryDefaults(
  input: { provider?: Record<string, ConfigProviderEntry> },
): ConfigProviderEntry & { models: Record<string, Record<string, unknown>> } {
  input.provider ??= {}
  const provider = (input.provider[PROVIDER_ID] ??= {})
  provider.npm ??= "@ai-sdk/openai-compatible"
  provider.name ??= "Kimi For Coding (OAuth)"
  provider.options = { baseURL: API_BASE_URL, ...provider.options }
  provider.models ??= {}
  return provider as ConfigProviderEntry & { models: Record<string, Record<string, unknown>> }
}

// Every `<PROVIDER_ID>/<key>` reference anywhere in the runtime config —
// default model, agents, modes, wherever. Used to guarantee that anything the
// user pointed at us actually resolves, even before the first successful
// discovery (otherwise opencode refuses to start on an unresolvable default).
function collectProviderModelRefs(value: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (!value || depth > 8) return out
  if (typeof value === "string") {
    if (value.startsWith(`${PROVIDER_ID}/`)) {
      const key = value.slice(PROVIDER_ID.length + 1).trim()
      if (key) out.add(key)
    }
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProviderModelRefs(item, out, depth + 1)
    return out
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectProviderModelRefs(item, out, depth + 1)
  }
  return out
}

// Minimal placeholder for a referenced-but-unknown key. The key doubles as
// the wire id: legacy slugs stay valid upstream; display-name keys fail loud
// server-side instead of silently routing somewhere else. Image metadata is
// required from the start — opencode strips image parts before the loader
// ever sees them unless the entry advertises attachment/modalities.
function bootstrapModelEntry(key: string): Record<string, unknown> {
  return {
    id: key,
    name: key,
    reasoning: true,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: DEFAULT_CONTEXT_LENGTH, output: DEFAULT_OUTPUT_LIMIT },
    options: {},
    variants: effortVariants(),
  }
}

// Inject the provider entry and its model list into opencode's config before
// providers initialize (same mechanism opencode-qwencode-auth uses). Model
// set is server-discovered when possible, the last-known-good cache second;
// nothing is invented beyond what the user's own config references.
function upsertProviderConfig(input: { provider?: Record<string, ConfigProviderEntry> }, models: ReadonlyArray<KimiModelInfo>) {
  const provider = ensureProviderEntryDefaults(input)
  for (const { key, model } of keyedModels(models)) {
    const generated = configModelEntry(model)
    const existing = provider.models[key]
    provider.models[key] = isPlainObject(existing) ? mergeModelConfig(generated, existing) : generated
  }
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
 *   3. `config`  — startup model sync: fetches `/coding/v1/models` with the
 *                  stored token and injects the provider entry + full model
 *                  list into opencode's config, so newly released Kimi Code
 *                  models appear in the picker without a plugin update or a
 *                  manual config block (mirrors kimi-cli's background
 *                  `refresh_managed_models`).
 *   4. `provider.models` — patches opencode's runtime model metadata
 *                  (`context_length`, `display_name`, media capabilities)
 *                  from the same discovery and materializes discovered models
 *                  missing from the config.
 *   5. `chat.headers` — computes the Kimi-specific request body fields the
 *                  model actually needs (`thinking.type`,
 *                  `reasoning_effort`, `prompt_cache_key`) and passes them to
 *                  `loader.fetch` via private headers.
 *   6. `chat.params` — mirrors the same fields into `output.options` for
 *                  forward-compat if opencode fixes its current
 *                  openai-compatible providerOptions namespace mismatch.
 */
const plugin: Plugin = async ({ client }) => {
  // --- helpers ---------------------------------------------------------------

  let cachedDiscovery: ModelDiscovery = {}
  let refreshPromise: Promise<OAuthAuth> | undefined
  let warnedDiscoveryFailure = false

  // Seed the in-memory discovery from the last-known-good cache so a start
  // during an outage (or with a lapsed membership) still shows the full
  // previously-seen list instead of an empty picker. The server is still
  // queried first everywhere; this is strictly fallback material.
  try {
    const seeded = await readDiscoveryCache()
    if (seeded?.length) cachedDiscovery = { models: seeded }
  } catch {}

  // One actionable log line per process when model sync degrades — silence
  // here reads as "the plugin is broken" and sends users hunting for the
  // wrong cause.
  const warnDiscoveryFailure = (error: unknown) => {
    if (warnedDiscoveryFailure) return
    warnedDiscoveryFailure = true
    const status = (error as { status?: number }).status
    const detail =
      status === 402
        ? "membership check failed — renew or verify your plan at https://kimi.com/coding"
        : status === 401 || status === 403
          ? "authentication failed — run `opencode auth login kimi-for-coding-oauth`"
          : error instanceof Error
            ? error.message
            : String(error)
    console.warn(
      `[kimi-for-coding-oauth] model sync failed${status ? ` (HTTP ${status})` : ""}: ${detail}. Using the last known model list.`,
    )
  }

  // The catalog the chat hooks gate on: the server-discovered list once
  // discovery has succeeded in this process, seeded from the last-known-good
  // cache on cold starts. Empty until then — unknown references stay ungated
  // so entitlement mistakes surface from the server instead of being silently
  // decorated with Kimi-specific fields (kimi-cli keeps no static list either).
  const catalog = (): ReadonlyArray<KimiModelInfo> => cachedDiscovery.models ?? []

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

  const rememberDiscovery = async (models: KimiModelInfo[]): Promise<ModelDiscovery> => {
    // Always overwrite, even with an empty list: a successful `/models`
    // response is authoritative (kimi-cli removes gone models), so stale
    // entries must not survive it — in memory OR on disk, or a restart would
    // resurrect removed models. Errors never reach this call.
    cachedDiscovery = { models }
    try {
      await writeDiscoveryCache(models)
    } catch {}
    return cachedDiscovery
  }

  const readLiveAuth = async () => {
    const auth = await readAuth()
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
        return await refreshAuthWithLock(auth, {
          force,
          readLatest: readLiveAuth,
          persist: persistAuth,
        })
      } finally {
        refreshPromise = undefined
      }
    })()
    return refreshPromise
  }

  // --- return hooks ----------------------------------------------------------

  return {
    /**
     * Startup model sync, mirroring kimi-cli's `refresh_managed_models`
     * background task (research/kimi-cli/src/kimi_cli/app.py). Runs before
     * opencode reads `cfg.provider`, so the discovered models land in the
     * provider's model picker without any manual config block. Kimi access
     * tokens live ~15 min, so a cold start almost always holds an expired
     * one — refresh it first (same lock/refresh path the loader uses), then
     * discover. Degradation ladder when the server cannot serve the list:
     * in-process discovery → last-known-good cache → inject nothing (only
     * referenced-key placeholders get synthesized), with one actionable
     * console.warn explaining why. Never throws — a failing network must not
     * break opencode startup.
     */
    config: async (input) => {
      try {
        // SERVER-FIRST, always: the live query runs on every startup whenever
        // a token exists — the last-known-good cache is only consulted when
        // that query fails. Seeding from the cache must never short-circuit
        // discovery, or newly released models would stay invisible until a
        // token refresh happened to fire.
        let models: KimiModelInfo[] | undefined
        const auth = await readLiveAuth()
        if (auth) {
          try {
            const fresh = isAuthExpiring(auth) ? await refreshAuth(auth) : auth
            try {
              models = (await rememberDiscovery(await listModels(fresh.access))).models
            } catch (error) {
              if ((error as { status?: number }).status !== 401) {
                warnDiscoveryFailure(error)
              } else {
                try {
                  models = (await rememberDiscovery(await listModels((await refreshAuth(fresh, true)).access))).models
                } catch (retryError) {
                  warnDiscoveryFailure(retryError)
                }
              }
            }
          } catch (error) {
            warnDiscoveryFailure(error)
          }
        }
        if (!models?.length) models = cachedDiscovery.models
        if (models?.length) upsertProviderConfig(input, models)

        // ...but never leave a dangling reference: anything in the runtime
        // config pointing at this provider must resolve, or opencode refuses
        // to start ("Model not found" on cfg.model). Synthesize minimal
        // placeholder entries for referenced keys that have no real entry.
        const refs = collectProviderModelRefs(input)
        if (refs.size) {
          const provider = ensureProviderEntryDefaults(input)
          const missing = [...refs].filter((key) => !provider.models[key])
          if (missing.length) {
            for (const key of missing) provider.models[key] = bootstrapModelEntry(key)
            console.warn(
              `[kimi-for-coding-oauth] no server model list available yet (offline start, login pending, or membership check failed) — synthesized placeholder entries for: ${missing.join(", ")}. Requests on them fail upstream until the first successful sync; restart after renewing/checking your plan at https://kimi.com/coding.`,
            )
          }
        }
      } catch {
        /* startup must never fail because of model sync */
      }
    },
    provider: {
      id: PROVIDER_ID,
      models: async (provider, ctx) => {
        if (!isOAuthAuth(ctx.auth)) return provider.models

        const discover = async (auth: OAuthAuth) => {
          const models = (await rememberDiscovery(await listModels(auth.access))).models ?? []
          return applyDiscoveryToModels(provider.models, models)
        }

        const current = (await readCurrentAuth()) ?? ctx.auth
        let auth = current
        try {
          if (isAuthExpiring(auth)) auth = await refreshAuth(auth)
          return await discover(auth)
        } catch (error) {
          if (auth !== current || (error as { status?: number }).status !== 401) {
            warnDiscoveryFailure(error)
            return provider.models
          }
        }

        try {
          return await discover(await refreshAuth(current, true))
        } catch (error) {
          warnDiscoveryFailure(error)
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
          discovery = await rememberDiscovery(await listModels(access))
          return discovery
        }

        const ensureDiscovered = async (auth: OAuthAuth & Partial<ModelDiscovery> & Partial<SingleModelDiscovery>) => {
          if (!discovery.models?.length) {
            if (auth.models?.length) {
              discovery = { models: auth.models }
            } else if (auth.model_id) {
              // Backward compatibility: in-memory auth snapshots may carry a
              // single discovered model_id from older plugin versions/tests.
              discovery = {
                models: [
                  {
                    id: auth.model_id,
                    display_name: auth.model_display,
                    context_length: auth.context_length,
                    supports_image_in: auth.supports_image_in,
                    supports_video_in: auth.supports_video_in,
                  } as KimiModelInfo,
                ],
              }
            }
            if (discovery.models?.length) cachedDiscovery = discovery
          }
          if (discovery.models?.length) return { ...auth, ...discovery }
          try {
            return { ...auth, ...(await discoverModelInfo(auth.access)) }
          } catch {
            return { ...auth, ...discovery }
          }
        }

        const ensureFresh = async (force = false): Promise<OAuthAuth & ModelDiscovery & Partial<SingleModelDiscovery>> => {
          const current = (await readCurrentAuth(readAuth)) as (OAuthAuth & Partial<ModelDiscovery> & Partial<SingleModelDiscovery>) | undefined
          if (!current || current.type !== "oauth")
            throw new Error(
              "kimi-for-coding-oauth: not logged in — run `opencode auth login kimi-for-coding-oauth`",
            )
          if (!force && !isAuthExpiring(current)) return ensureDiscovered(current)
          const next = await refreshAuth(current, force)
          // kimi-cli re-runs `refresh_managed_models` on every successful
          // refresh — we mirror that so entitlement or display-name changes
          // are picked up without a full re-login. Failures here must not
          // block the refresh: a warm in-memory discovery still works for the
          // common case, and the request-path 401 retry will flush a broken
          // access token.
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

              // Rewrite the wire `model` to the server-discovered id when it
              // differs from what opencode sent. opencode bakes the model id
              // into the LanguageModel instance at provider-init time, so
              // `chat.params` cannot change it. We rewrite the JSON body here
              // instead. Mirrors kimi-cli's behavior — it sends the id it got
              // back from `/models`.
              let newInit = init
              const originalBody =
                typeof init?.body === "string"
                  ? init.body
                  : input instanceof Request && init?.body === undefined
                    ? await input
                        .clone()
                        .text()
                        .catch(() => undefined)
                    : undefined
              if (originalBody) {
                try {
                  const parsed = JSON.parse(originalBody)
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    const requestedModelId = typeof parsed.model === "string" ? parsed.model : undefined
                    // Resolve the requested reference (user-facing key, raw
                    // server id, or case/whitespace variant) to its discovery
                    // entry. The legacy MODEL_ID placeholder falls back to the
                    // discovered slug ONLY when discovery returned exactly one
                    // model — that pick is unambiguous. With several models
                    // (or none), guessing models[0] could silently run the
                    // request on a different model than the user selected, so
                    // we leave the id on the wire and let the server answer
                    // with a visible entitlement error instead.
                    const info = requestedModelId
                      ? (findDiscovered(requestedModelId, auth.models) ??
                        (requestedModelId === MODEL_ID && auth.models?.length === 1 ? auth.models[0] : undefined))
                      : undefined
                    const targetModel = info?.id
                    const changedBody =
                      (targetModel && targetModel !== requestedModelId) || hasKimiBodyFields(kimiBodyFields)
                    if (targetModel && targetModel !== requestedModelId) {
                      parsed.model = targetModel
                    }
                    if (hasKimiBodyFields(kimiBodyFields)) {
                      applyKimiBodyFields(parsed as Record<string, unknown>, kimiBodyFields)
                    }
                    if (changedBody) {
                      newInit = { ...init, body: JSON.stringify(parsed) }
                    }
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
                    const models = (await rememberDiscovery(await listModels(tokens.access_token))).models ?? []
                    if (models.length) {
                      // Print the discovered model set. opencode shows this
                      // next to the "Authorized" message.
                      const block = buildConfigBlock(models)
                      console.log(
                        `\n✓ Authorized for Kimi For Coding (models: ${models.map((m) => m.id).join(", ")})\n\n` +
                          `The plugin injects these models into your opencode config automatically at startup — no manual provider block needed.\n\n` +
                          `If you prefer pinning the config yourself (~/.config/opencode/opencode.json):\n\n${block}\n`,
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
      const fields = resolveKimiBodyFields(input as KimiHookInput, catalog())
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
      const fields = resolveKimiBodyFields(input as KimiHookInput, catalog())
      if (!fields) return
      applyKimiBodyFields(output.options, fields)
    },
  }
}

// v1 PluginModule format — bypasses getLegacyPlugins entirely.
// For npm-sourced plugins, id is optional (falls back to package.json name),
// but we set it explicitly for clarity.
export default {
  id: "opencode-kimi-full",
  server: plugin,
} satisfies PluginModule
