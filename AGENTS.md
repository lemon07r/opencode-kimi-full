# AGENTS.md — working notes for coding agents (and humans)

This file is the single source of truth for any AI agent (or human) modifying this repo. Read it top-to-bottom before touching code. If something you learn here contradicts what you see in the code, the **code wins** — update this file in the same commit.

User-facing install / usage documentation lives in [`README.md`](./README.md). Do **not** duplicate it here.

---

### Purpose

One plugin, one job: make `opencode` talk to Kimi's `kimi-for-coding` endpoint **exactly the way the official `kimi-cli` does**. Everything in this repo exists to minimize drift from upstream kimi-cli.

### The one rule that matters

> Moonshot's backend picks the model (K2.5 vs K2.6) from the **auth token type**, not the model-name string.

- Static `sk-kimi-...` API key → K2.5.
- OAuth JWT with `scope: kimi-code` → K2.6.

Every design decision here follows from that: we do device-flow OAuth, we do not accept API keys, we do not let the upstream SDK attach its own Authorization header.

### Non-goals

- No support for K2.5 or any non-`kimi-for-coding` model. opencode already handles those via Moonshot / Baseten / Alibaba-CN / etc.
- No support for static API keys. Users who want that can use a different opencode provider entry.
- No custom SSE parser, tool-call normalizer, or message rewriter. `@ai-sdk/openai-compatible` already does SSE/`reasoning_content` correctly.

---

### Architecture

Three files, 1 job each. Do not add a fourth unless the existing three genuinely can't hold a new concern.

| File               | Responsibility                                                                 |
|--------------------|--------------------------------------------------------------------------------|
| `src/constants.ts` | Pinned strings that must mirror upstream kimi-cli (version, endpoints, client id, scope). |
| `src/headers.ts`   | The seven `X-Msh-*` / UA headers + the persistent `~/.kimi/device_id` file.    |
| `src/oauth.ts`     | Device-code start, device-code poll, refresh-token exchange. Nothing else.     |
| `src/index.ts`     | Plugin entry. Wires `auth` hook (login + loader) and `chat.params` hook.       |

Data flow on a chat request:

1. opencode asks the `@ai-sdk/openai-compatible` provider for a language model.
2. Before instantiating it, opencode calls our `auth.loader`. We return `{ apiKey, fetch }`.
3. The SDK uses our `fetch` for every HTTP call (models, chat, whatever).
4. Our `fetch` calls `ensureFresh()` → maybe refreshes → sets Authorization + the seven `X-Msh-*` headers → on 401 refreshes once and retries.
5. Separately, opencode runs the `chat.params` hook and writes `thinking`, `reasoning_effort`, `prompt_cache_key` into `output.options`. opencode wraps those as `{ [providerID]: options }` and the openai-compatible SDK forwards them as top-level body fields. That is why those keys must use **exactly** the wire names (`prompt_cache_key`, `reasoning_effort`, `thinking`).

### Contracts to keep intact

These are the invariants that, if broken, silently degrade K2.6 → K2.5 or produce fingerprint-based throttling. Do not "clean them up" without reading the linked upstream.

1. **`X-Msh-Version` and `User-Agent` must track `kimi-cli`.** Bumping involves exactly one line in `src/constants.ts`. See upstream `research/kimi-cli/src/kimi_cli/constant.py`.
2. **`X-Msh-Device-Id` must be stable across runs.** Never regenerate a fresh UUID at import time. `getDeviceId()` reads/writes `~/.kimi/device_id`; that path is shared with `kimi-cli` on purpose.
3. **`Authorization` header is owned by `loader.fetch`.** Anything else (opencode core, the SDK, future hooks) must be overridden. Our `loader` deletes both `authorization` and `Authorization` before setting its own.
4. **Effort ↔ fields mapping** (kimi-cli `llm.py` / `kosong/chat_provider/kimi.py`):

   | Effort   | `reasoning_effort` | `thinking.type` |
   |----------|--------------------|-----------------|
   | `off`    | *(omitted)*        | `"disabled"`    |
   | `low`    | `"low"`            | `"enabled"`     |
   | `medium` | `"medium"`         | `"enabled"`     |
   | `high`   | `"high"`           | `"enabled"`     |

   Do not send `thinking.type="enabled"` with no `reasoning_effort` unless the request never had one to begin with (the default "server picks" case).

5. **`prompt_cache_key` only for `kimi-for-coding`.** Never attach it to unrelated models. The check is `input.model.id === MODEL_ID` in `chat.params`.
6. **Model id goes over the wire verbatim.** Don't strip the `kimi-` prefix — the backend expects exactly `kimi-for-coding`.
7. **Auth store is opencode's, not kimi-cli's.** We use `client.auth.get/set` against the `kimi-for-coding-oauth` provider id. Do not read/write `~/.kimi/credentials/kimi-code.json`; that's kimi-cli's file and sharing it across independent apps causes token-race bugs.
8. **Provider id must not collide with any id in the [models.dev](https://models.dev) catalog.** models.dev publishes `kimi-for-coding` (static `KIMI_API_KEY` → `@ai-sdk/anthropic` → K2.5). If we registered under that same id, `opencode auth login kimi-for-coding` would surface two methods under one entry and users picking the API-key one would silently land on K2.5. We deliberately use `kimi-for-coding-oauth` instead; `MODEL_ID` on the wire stays `kimi-for-coding` (rule 6).

### Working on this repo

- **Code style:** see `tsconfig.json` (strict, `noUncheckedIndexedAccess`, ES2022). Prefer small pure functions, avoid `try`/`catch` except where we genuinely convert one error shape to another.
- **Comments:** match the existing density — only explain non-obvious upstream-parity reasoning. Do not narrate the obvious ("// refresh the token"); instead reference upstream files when the reasoning is "because kimi-cli does it that way".
- **Dependencies:** runtime deps stay at **zero**. The only dev/peer dep is `@opencode-ai/plugin` for types.
- **Git commits:** small, logical, imperative subject ("Add oauth device flow"). Do not add a `Co-authored-by` trailer.
- **Upstream research:** the `research/` directory is a read-only git-ignored pair of shallow clones (opencode + kimi-cli) for grep. Never edit files there; re-clone if you suspect drift. When citing upstream in a comment, use the `research/…` path so the reference is resolvable.
- **Version bumps:** when kimi-cli bumps, (1) pull a fresh `research/kimi-cli`, (2) update `KIMI_CLI_VERSION` in `src/constants.ts`, (3) re-diff `_kimi_default_headers()` / `oauth.py` against `src/headers.ts` and `src/oauth.ts`, (4) smoke-test with `opencode auth login kimi-for-coding-oauth` and a one-turn chat, (5) tag release.

### What not to do

- ❌ Don't add heuristics that look at the model id outside of `chat.params`. The `auth.loader` fetch is already scoped to this provider; the only place that needs to match on `kimi-for-coding` is the params hook.
- ❌ Don't rename the provider id back to `kimi-for-coding` or to anything else listed in models.dev. See rule 8.
- ❌ Don't add new header values that kimi-cli doesn't send. The fingerprint matters.
- ❌ Don't call out to other files to "share" the kimi-cli credentials. Different OAuth consumers must have independent refresh-token chains or one will invalidate the other.
- ❌ Don't introduce a build step. The plugin ships as `.ts` and opencode's bun-based loader handles it.
- ❌ Don't add tests that require real Kimi credentials and check them in. If you add offline unit tests, put them under `test/` and mock `fetch`.

### How to verify a change

Offline:

```sh
bun build --target=node --no-bundle src/index.ts   # syntax/type-ish check
```

Online (requires a real Kimi-for-coding account):

1. `cd ~/.opencode && bun add /path/to/this/repo`
2. Paste the provider block from `README.md` into your opencode config.
3. `opencode auth login kimi-for-coding-oauth` — confirm a token lands in opencode's `auth.json` with `type: "oauth"`, a JWT `access`, and `expires` ~15 min in the future.
4. Start opencode, select `kimi-for-coding-oauth/kimi-for-coding`, and ask the model to self-identify. It should claim to be K2.6 / `kimi-for-coding`.
5. Confirm `reasoning_content` deltas render as thinking content (not assistant text).
6. In a second turn of the same session, confirm the response comes back faster (cache hit via `prompt_cache_key`).

If any of 3–6 fails, diff `research/kimi-cli` against the contracts above.

### House rules for AI agents

- Read this file first. Every time.
- Don't grow the dependency footprint to "simplify" something; this plugin's value is being small and audit-able.
- When in doubt, mirror kimi-cli exactly, then comment the upstream reference. "We used to deviate, it broke" — document it here.
- Keep `README.md` user-focused and this file contributor-focused. If you catch yourself duplicating, move content here and link from the README.
- Any new rule you add here must have a real incident or a grep-verified upstream source behind it. No speculative "best practices".
