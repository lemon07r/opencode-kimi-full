# AGENTS.md — working notes for coding agents (and humans)

This file is the single source of truth for any AI agent (or human) modifying this repo. Read it top-to-bottom before touching code. If something you learn here contradicts what you see in the code, the **code wins** — update this file in the same commit.

User-facing install / usage documentation lives in [`README.md`](./README.md). Do **not** duplicate it here.

---

### Purpose

One plugin, one job: make `opencode` talk to Kimi's `kimi-for-coding` endpoint **exactly the way the official `kimi-cli` does**. Everything in this repo exists to minimize drift from upstream kimi-cli.

### The one rule that matters

> Moonshot's coding backend is entitlement-sensitive: the model-name string alone is not the whole story.

Every design decision here follows from that: we do device-flow OAuth to mirror official `kimi-cli`, we do not accept API keys in this plugin, and we do not let the upstream SDK attach its own Authorization header.

### Non-goals

- No support for any model outside the Kimi Code family — where "the family" is defined by whatever `GET /coding/v1/models` returns, not by a hardcoded list. opencode already handles other Moonshot / Baseten / Alibaba-CN / etc. entries itself.
- No support for static API keys. Users who want that can use a different opencode provider entry.
- No custom SSE parser, tool-call normalizer, or message rewriter. `@ai-sdk/openai-compatible` already does SSE/`reasoning_content` correctly.

---

### Architecture

Each source file has one job. Do not add new files unless the existing ones genuinely can't hold a new concern.

| File               | Responsibility                                                                 |
|--------------------|--------------------------------------------------------------------------------|
| `src/constants.ts` | Pinned strings that must mirror upstream kimi-cli (version, endpoints, client id). Deliberately contains NO model list — server discovery + the last-known-good cache are the only sources (see rule 6). |
| `src/headers.ts`   | The seven `X-Msh-*` / UA headers + the persistent `~/.kimi/device_id` file.    |
| `src/oauth.ts`     | Device-code start, device-code poll, refresh-token exchange, and `GET /coding/v1/models` discovery. |
| `src/auth-store.ts`| Read/write opencode's `auth.json` entries for this provider.                    |
| `src/auth-refresh.ts`| Lock-based token refresh with cross-instance coordination, `ensureFreshStoredAuth` for standalone callers. |
| `src/index.ts`     | Plugin entry (v1 `PluginModule` format). Wires `config` (startup model sync), `auth` (login + loader), `provider.models` (runtime metadata patching + materializing new models), and the Kimi chat hooks/body rewrite. |
| `src/usage.ts`     | Fetch and parse Kimi subscription usage (`/coding/v1/usages`).                 |
| `src/tui.tsx`      | TUI slash command `/kimi:usage` — renders usage in an opencode dialog.         |

Data flow on a chat request:

0. At startup, the `config` hook runs before opencode reads `cfg.provider`: it refreshes the stored token when expiring (Kimi access tokens live ~15 min), fetches `/coding/v1/models` server-first on EVERY startup (the last-known-good cache only fills the gap when the live query fails), and injects the provider entry + one model entry per discovered model (union with user config, user keys win). This mirrors kimi-cli's background `refresh_managed_models` task and is what makes newly released models appear without a plugin update. When neither the server nor the cache yields a list, no DISCOVERED entries are injected — but placeholder repair for dangling `<provider>/<key>` references still runs (see rule 6), so startup never dies.
1. opencode asks the `@ai-sdk/openai-compatible` provider for a language model.
2. Before instantiating it, opencode calls our `auth.loader`. We return `{ apiKey, fetch }`.
3. The SDK uses our `fetch` for every HTTP call (models, chat, whatever).
4. Our `fetch` calls `ensureFresh()` → prefers the live opencode auth-store entry over stale `OPENCODE_AUTH_CONTENT` snapshots → maybe refreshes (sharing one in-flight promise in-process and a lock across plugin instances so they don't race the same refresh token) → lazily discovers `/coding/v1/models` when needed → sets Authorization + the seven `X-Msh-*` headers → on 401 refreshes once and retries.
5. Separately, opencode runs `chat.headers` and `chat.params`. `chat.headers` computes `thinking`, `reasoning_effort`, and `prompt_cache_key` from `input.model.options` plus the selected `input.message.model.variant`, then passes them to `loader.fetch` via private `x-opencode-kimi-*` headers. `loader.fetch` strips those headers and injects the wire fields into the JSON body. `chat.params` mirrors the same keys into `output.options` only as a forward-compat fallback if opencode later fixes its openai-compatible providerOptions namespace mismatch.

### Contracts to keep intact

These are the invariants that, if broken, silently route requests onto the wrong auth/backend path or produce fingerprint-based throttling. Do not "clean them up" without reading the linked upstream.

1. **`X-Msh-Version` and `User-Agent` must track `kimi-cli`.** Bumping involves exactly one line in `src/constants.ts`. See upstream `research/kimi-cli/src/kimi_cli/constant.py`. The UA prefix is `KimiCLI/` (not `KimiCodeCLI/`) — Moonshot's `kimi-for-coding` backend 403s with `access_terminated_error: only available for Coding Agents such as Kimi CLI, Claude Code, Roo Code…` on any other prefix. Likewise, `X-Msh-Device-Model` must mirror kimi-cli's `_device_model()` shape, including the Darwin/Windows special cases (`macOS <version> <arch>`, `Windows 10/11 <arch>`, Linux `"{system} {release} {machine}"`) — NOT just `{arch}` — and `X-Msh-Os-Version` is the kernel build string from `os.version()`, NOT `"{type} {release}"`. Tested live against `api.kimi.com/coding/v1` on 2026-04-17 — any of those three fields off-spec → 403.
2. **`X-Msh-Device-Id` must be stable across runs.** Never regenerate a fresh UUID at import time. `getDeviceId()` reads/writes `~/.kimi/device_id`; that path is shared with `kimi-cli` on purpose.
3. **`Authorization` header is owned by `loader.fetch`.** Anything else (opencode core, the SDK, future hooks) must be overridden. Our `loader` deletes both `authorization` and `Authorization` before setting its own. The private `x-opencode-kimi-*` transport headers are also consumed and stripped there; they must never leak upstream.
4. **Effort ↔ fields mapping** (kimi-cli `llm.py` / `kosong/chat_provider/kimi.py`):

   | Effort   | `reasoning_effort` | `thinking`            | model(s)                              |
   |----------|--------------------|-----------------------|---------------------------------------|
   | `auto`   | *(omitted)*        | *(omitted)*           | any                                   |
   | `off`    | *(omitted)*        | `{type:"disabled"}`   | any                                   |
   | `low`    | `"low"`            | `{type:"enabled"}`    | any                                   |
   | `medium` | `"medium"`         | `{type:"enabled"}`    | any                                   |
   | `high`   | `"high"`           | `{type:"enabled"}`    | any                                   |
   | `xhigh`  | `"high"` (clamped) | `{type:"enabled"}`    | any                                   |
   | `max`    | `"max"`            | `{type:"enabled"}`    | `k3`                                  |
   | `max`    | `"high"` (clamped) | `{type:"enabled"}`    | `kimi-for-coding`, `kimi-for-coding-highspeed` |

   `auto` is the "let the server decide dynamically" variant — neither field is sent, matching kimi-cli's "nothing passed" default. `xhigh` is clamped to `"high"` for all current Kimi Code models because Kimi's backend does not support it. Effort capability is SERVER-DRIVEN: a discovered model's `think_efforts.valid_efforts` decides whether `max` passes through (k3/k3-256k advertise it); models without the field clamp `max`→`high` conservatively, because an unsupported effort value fails the request upstream. There is deliberately NO client-side capability table (MAX_REASONING_MODEL_IDS was removed) — server is the only source of truth, per rule 6. When no effort is set at all, the plugin still emits `thinking: {type: "enabled"}` because the model is a reasoner. Compute this from `input.model.options` plus `input.model.variants[input.message.model.variant]`, gated on `findDiscovered(input.model.id, catalog())` (see rule 5), not from `input.provider.info.id`. A model whose discovery entry carries `supports_reasoning: false` never receives `thinking`/`reasoning_effort` (kimi-cli gates its "thinking" capability on the same flag); `prompt_cache_key` still attaches. The `@opencode-ai/plugin` `ProviderContext` type claims `.info.id` exists, but the runtime shape opencode passes (see `research/opencode/packages/opencode/src/session/llm.ts::stream`, ~line 168, `provider: item`) is the flat `ProviderConfig` (`.id`). `input.model.providerID` is what every first-party plugin uses (cloudflare.ts, codex.ts, github-copilot/copilot.ts) and it avoids the runtime crash "undefined is not an object (evaluating 'input.provider.info.id')". Tested live 2026-04-17.

5. **`prompt_cache_key` only for Kimi Code models.** Never attach it to unrelated models. The check is `findDiscovered(input.model.id, catalog())` in the Kimi chat hooks, where `catalog()` is the server-discovered list (seeded from the last-known-good cache on cold starts — there is no static fallback; see rule 6); the legacy `MODEL_ID` sentinel still passes, and the actual wire injection happens in `loader.fetch`.
6. **The model list is server-driven AND the naming is WYSIWYG.** kimi-cli keeps no static model list at all: `refresh_managed_models` (`research/kimi-cli/src/kimi_cli/auth/platforms.py`) treats `GET /coding/v1/models` as the full truth — adding new models, updating metadata, and removing gone ones. We mirror that: the `config` hook refreshes the stored token when it is expiring (Kimi access tokens live ~15 min, so a cold start almost always needs it — without the refresh, startup discovery 401s and silently degrades to the fallback) and injects every discovered model into opencode's config at startup (union semantics — user-written entries are never deleted, which is the one deliberate deviation from kimi-cli's remove-gone behavior, because opencode config is user-owned); `provider.models` materializes discovered models missing from the runtime map; `rememberDiscovery` overwrites even on an empty list because a successful response is authoritative and persists each success to a last-known-good cache file (`kimi-for-coding-oauth.models.json` next to auth.json) that seeds cold starts during outages or HTTP 402 membership lapses. There is NO static model table: when neither the server nor the cache yields a list, the `config` hook injects nothing (same contract as opencode core's gitlab `discoverModels`, which returns {} on failure). Plugins that hardcode tables (antigravity-auth) do so because their upstream has no discovery endpoint — Kimi has one, and kimi-cli keeps none either. The ONE exception: `collectProviderModelRefs` + `bootstrapModelEntry` synthesize minimal entries for `<provider>/<key>` strings found anywhere in the runtime config — without this, a dangling default/agent reference makes opencode refuse to start ("Model not found"). Placeholders use the key as wire id, so they fail loud upstream instead of silently routing elsewhere.
   **Naming contract (v1.6.0):** the config key = the picker label = what users write in agents/json. Keys derive from `display_name` via `keyedModels()` (collision → raw id); the raw server slug travels on the wire via each entry's `id` field — opencode resolves wire ids through `apiID = model.id ?? existingModel?.api.id ?? key` in provider.ts, so display keys never leak upstream. The loader's fetch rewrite (`findDiscovered`) accepts the exact key, the raw id, and case/whitespace variants as a safety net; capability checks (effort clamping) consult the discovery entry's `think_efforts.valid_efforts` — never a client-side model table. Never assume key === server id anywhere new. A model with `supports_thinking_type: "only"` (all current Kimi Code models) ALWAYS gets `thinking: {type:"enabled"}` — `off`/`auto`/unset are clamped to enabled, because the model cannot think-lessly answer and a forgotten variant must not silently degrade reasoning. When the server enumerates `think_efforts.valid_efforts`, the picker ladder is built from exactly those tiers (plus off/auto) and any effort NOT advertised is omitted from the wire — the server then applies its `default_effort` (live example: k3 advertises low/high/max, so `medium` is neither offered nor sent).
7. **Auth store is opencode's, not kimi-cli's.** We use opencode's auth store for tokens under the `kimi-for-coding-oauth` provider id. Do not read/write `~/.kimi/credentials/kimi-code.json`; that's kimi-cli's file and sharing it across independent apps causes token-race bugs. The plugin may live-read opencode's `auth.json` entry for this provider to bypass stale `OPENCODE_AUTH_CONTENT` workspace snapshots, but writes still go through opencode's auth store (`client.auth.set`). Also note that opencode's SDK auth schema only persists the standard oauth fields, so model discovery metadata cannot be stored there durably.
8. **Provider id must not collide with any id in the [models.dev](https://models.dev) catalog.** models.dev publishes `kimi-for-coding` as a separate API-key-driven integration. If we registered under that same id, `opencode auth login kimi-for-coding` would surface two methods under one entry and users could silently land on the wrong integration path. We deliberately use `kimi-for-coding-oauth` instead; `MODEL_ID` on the wire stays `kimi-for-coding` (rule 6).
9. **`src/index.ts` must have exactly one export — the default `PluginModule` object `{ id, server }`.** opencode's plugin loader (`research/opencode/packages/opencode/src/plugin/index.ts`) first tries `readV1Plugin` (detect mode) on the default export. If it finds an object with `server` (and optional `id`), it uses the v1 path directly. The older legacy path (`getLegacyPlugins`) iterates every export and throws `Plugin export is not a function` on any non-callable value — a problem that surfaced on Windows where Bun's standalone-binary dynamic imports can produce module namespace objects with unexpected non-function metadata. The v1 format bypasses `getLegacyPlugins` entirely. Keep constants in `src/constants.ts` and import them in `src/index.ts` rather than re-exporting. `test/exports.test.ts` guards this. The failure mode of a broken export is silent in the CLI (the provider just doesn't appear in `opencode auth login`); the error only surfaces in `~/.local/share/opencode/log/*.log`.
10. **Generated model config entries must carry a complete `limit` object.** opencode's live config schema at `https://opencode.ai/config.json` requires both `limit.context` and `limit.output` whenever `limit` is present. `configModelEntry()`/`buildConfigBlock()` therefore emit `limit.context` from the server-reported `context_length` (falling back to `DEFAULT_CONTEXT_LENGTH` = 256_000 when the server omits it) and a conservative `limit.output` of `65536`. Do not set `limit.input` heuristically; opencode's overflow logic treats `limit.input` as authoritative (`research/opencode/packages/opencode/src/session/overflow.ts`).
11. **Concurrent refreshes must collapse to one in-flight OAuth exchange, even across plugin instances.** `provider.models` and `auth.loader` can both notice an expiring token at about the same time, and separate opencode workspace/plugin instances can inherit stale auth snapshots. `refreshAuth()` in `src/index.ts` therefore shares one promise across overlapping callers, takes a provider-scoped auth-store lock before refreshing, re-reads opencode's live auth-store entry under that lock, and treats a changed on-disk token chain as authoritative. `test/plugin.test.ts` covers loader-vs-loader, provider.models-vs-loader, cross-instance lock reuse, and the `invalid_grant` self-heal path where another process already rotated the refresh token.
12. **Media-input capabilities must be backfilled from `/coding/v1/models`.** `supports_image_in` and `supports_video_in` from Kimi discovery are not cosmetic metadata: opencode's provider transform (`research/opencode/packages/opencode/src/provider/transform.ts::unsupportedParts`) rewrites every image part into local `ERROR: Cannot read ... (this model does not support image input)` text before the request reaches our loader when `capabilities.input.image` is false. Therefore the `config` hook generates `attachment: true` plus `modalities` for every injected model, `provider.models` patches runtime metadata for every known Kimi Code model id, and `buildConfigBlock()` includes the same fields when discovery says images/video are supported. `test/plugin.test.ts` covers both paths.

### Working on this repo

- **Code style:** see `tsconfig.json` (strict, `noUncheckedIndexedAccess`, ES2022). Prefer small pure functions, avoid `try`/`catch` except where we genuinely convert one error shape to another.
- **Comments:** match the existing density — only explain non-obvious upstream-parity reasoning. Do not narrate the obvious ("// refresh the token"); instead reference upstream files when the reasoning is "because kimi-cli does it that way".
- **Dependencies:** runtime deps are limited to `@opentui/core` and `@opentui/solid` (for the TUI slash command). The only dev/peer dep is `@opencode-ai/plugin` for types. Do not add further runtime deps.
- **Git commits:** small, logical, imperative subject ("Add oauth device flow"). Do not add a `Co-authored-by` trailer.
- **Upstream research:** the `research/` directory is a read-only git-ignored pair of shallow clones (opencode + kimi-cli) for grep. Never edit files there; re-clone if you suspect drift. When citing upstream in a comment, use the `research/…` path so the reference is resolvable.
- **Version bumps:** when kimi-cli bumps, (1) pull a fresh `research/kimi-cli`, (2) update `KIMI_CLI_VERSION` in `src/constants.ts`, (3) re-diff `_kimi_default_headers()` / `oauth.py` against `src/headers.ts` and `src/oauth.ts`, (4) smoke-test with `opencode auth login kimi-for-coding-oauth` and a one-turn chat, (5) tag release.
- **Tests:** `test/` holds one file per source file plus `test/exports.test.ts` (the rule-9 guard). Tests mock `fetch` via `test/_util/fetchMock.ts`; no real credentials or network. They use the real `~/.kimi/device_id` on purpose — it is shared with kimi-cli by design and `getDeviceId` is idempotent, so tests don't clobber state. When adding a new contract to the list above, add the matching offline check to the corresponding test file rather than creating new ones.

### What not to do

- ❌ Don't add heuristics that look at the model id outside of the Kimi chat hooks / `loader.fetch`. The auth loader is already scoped to this provider; only the chat hooks and the body rewrite need to match on known Kimi models (the server-discovered catalog, cache-seeded on cold starts — see rule 6).
- ❌ Don't rename the provider id back to `kimi-for-coding` or to anything else listed in models.dev. See rule 8.
- ❌ Don't add new header values that kimi-cli doesn't send. The fingerprint matters.
- ❌ Don't call out to other files to "share" the kimi-cli credentials. Different OAuth consumers must have independent refresh-token chains or one will invalidate the other.
- ❌ Don't introduce a build step. The plugin ships as `.ts` and opencode's bun-based loader handles it.
- ❌ Don't add tests that require real Kimi credentials and check them in. If you add offline unit tests, put them under `test/` and mock `fetch`.
- ❌ Don't add named exports to `src/index.ts` or change the default export away from the `{ id, server }` PluginModule shape. See rule 9.

### How to verify a change

Offline:

```sh
bunx tsc --noEmit                                  # type-check
bunx tsc --noEmit --project tsconfig.tests.json    # type-check tests/helpers
bun build --target=node --no-bundle src/index.ts   # syntax check
bun test                                           # offline unit tests
```

Online (requires a real Kimi-for-coding account):

1. Install the local checkout via opencode's plugin flow (`opencode plugin /path/to/this/repo --global`) or point the `plugin` array in your opencode config at the repo root, as shown in `README.md`.
2. No provider block is needed — the `config` hook injects it. Add one only to test override merging.
3. `opencode auth login kimi-for-coding-oauth` — confirm a token lands in opencode's `auth.json` with `type: "oauth"`, a JWT `access`, and `expires` ~15 min in the future.
4. Start opencode, select any `kimi-for-coding-oauth/*` model, and ask the model to self-identify. It should claim to be the selected Kimi Code model.
5. Confirm `reasoning_content` deltas render as thinking content (not assistant text). For `k3`, switch to the `max` variant and confirm the request includes `reasoning_effort: "max"`.
6. In a second turn of the same session, confirm the response comes back faster (cache hit via `prompt_cache_key`).

If any of 3–6 fails, diff `research/kimi-cli` against the contracts above.

### House rules for AI agents

- Read this file first. Every time.
- Don't grow the dependency footprint to "simplify" something; this plugin's value is being small and audit-able.
- When in doubt, mirror kimi-cli exactly, then comment the upstream reference. "We used to deviate, it broke" — document it here.
- Keep `README.md` user-focused and this file contributor-focused. If you catch yourself duplicating, move content here and link from the README.
- Any new rule you add here must have a real incident or a grep-verified upstream source behind it. No speculative "best practices".
