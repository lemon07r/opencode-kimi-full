## opencode-kimi-full

An [opencode](https://opencode.ai) plugin for the **Kimi For Coding** plan.

This plugin authenticates the same way the official [kimi-cli](https://github.com/MoonshotAI/kimi-cli) does and mirrors its wire shape, so opencode's requests to Moonshot's `/coding` endpoint match kimi-cli byte-for-byte, including OAuth, fingerprint headers, session-scoped prompt caching, and paired thinking / reasoning-effort fields for higher fidelity. The Kimi specific extras exposed by the /coding endpoint used by kimi-cli are not implemented in opencode. Bonus side effect; users with access to Kimi K2.6 Code Preview will get access to it in opencode with this plugin.

Contributor and agent documentation lives in [`AGENTS.md`](./AGENTS.md).

---

### Requirements

- `opencode` ≥ 1.4.6
- A Kimi account with an active **Kimi For Coding** subscription (the same plan that works with kimi-cli)

### Install

```sh
cd ~/.opencode
bun add opencode-kimi-full
```

<details>
<summary>From a local checkout</summary>

```sh
cd ~/.opencode
bun add /path/to/opencode-kimi-full
```

</details>

### Configure

Add the plugin and a provider entry to `opencode.json` (or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-kimi-full"],
  "provider": {
    "kimi-for-coding-oauth": {
      "name": "Kimi For Coding (OAuth)",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.kimi.com/coding/v1"
      },
      "models": {
        "kimi-for-coding": {
          "name": "Kimi For Coding",
          "reasoning": true,
          "options": {},
          "variants": {
            "auto":   { "reasoning_effort": "auto" },
            "off":    { "reasoning_effort": "off" },
            "low":    { "reasoning_effort": "low" },
            "medium": { "reasoning_effort": "medium" },
            "high":   { "reasoning_effort": "high" }
          }
        }
      }
    }
  }
}
```

Two identifiers are load-bearing:

- **provider id** `kimi-for-coding-oauth` — the plugin's `auth` and `chat.params` hooks match on it.
- **model id** `kimi-for-coding` — a stable opencode-side alias. The plugin rewrites the wire `model` field to whatever `/coding/v1/models` reports for your account (e.g. `kimi-for-coding` on K2.6 tiers, `k2p5` on K2.5 tiers). Both tiers use identical config.

> **Note.** The provider id is intentionally not `kimi-for-coding`. That id is already published by [models.dev](https://models.dev) and points at a static-API-key flow that routes to K2.5. Using a distinct id keeps the two paths from colliding under a single `opencode auth login` entry.

### Log in

```sh
opencode auth login -p kimi-for-coding-oauth
```

The plugin returns a verification URL and user code. After browser approval it polls the device-auth endpoint, queries `/coding/v1/models` to discover the model id and context length your account is entitled to, prints a ready-to-paste config block with those values filled in, and persists everything (tokens + discovered metadata) through opencode's `auth.json`. The model list is re-checked on every token refresh, mirroring kimi-cli's `refresh_managed_models`. Access tokens have a ~15 minute TTL and refresh automatically; refresh tokens last ~30 days.

### Use

Select `kimi-for-coding-oauth/kimi-for-coding` in opencode.

Press **Ctrl+T** to pick a reasoning variant (`auto`, `off`, `low`, `medium`, `high`). `auto` lets Moonshot pick dynamically; `off` disables thinking; `low`/`medium`/`high` pin the effort level.

---

<details>
<summary><strong>Why this plugin exists</strong></summary>

There are two ways to talk to Moonshot's Kimi For Coding plan today: the way kimi-cli does it, and the way opencode does it. They target different endpoints and use different authentication. This plugin brings kimi-cli parity into opencode.

**How kimi-cli does it.** OAuth device-code flow against `auth.moonshot.cn` with `scope: kimi-code`, producing a short-lived JWT. Requests go to `https://api.kimi.com/coding/v1` (OpenAI-compatible) with the JWT as the bearer token, seven `X-Msh-*` fingerprint headers, a stable `~/.kimi/device_id`, and per-request extras: `prompt_cache_key` (an opt-in, session-scoped cache key) and paired `thinking.type` + `reasoning_effort`. The backend routes this token to K2.6.

**How opencode does it out of the box.** `opencode auth login` selects a Kimi For Coding provider from the catalog and prompts for a `KIMI_API_KEY` (a static `sk-kimi-...` key). The catalog entry uses `@ai-sdk/anthropic` against `api.kimi.com/coding`, which is valid since the endpoint exposes both OpenAI-compatible and Anthropic-compatible routes. No Kimi-specific request extras are sent. The backend currently routes a static `sk-kimi-...` key to K2.5.

**What this plugin gives you.** Everything kimi-cli does, inside opencode:

- OAuth device flow with `scope: kimi-code`, so you land on K2.6 (if you have access).
- `prompt_cache_key` set to opencode's session id, for session-scoped cache reuse.
- Paired `thinking` + `reasoning_effort` fields.
- The seven `X-Msh-*` headers and a kimi-cli-shaped `User-Agent`.
- `~/.kimi/device_id` shared with a locally-installed kimi-cli.
- Tokens stored in opencode's `auth.json` under a dedicated provider id, so the plugin and kimi-cli keep independent refresh-token chains and do not invalidate each other.
- Streaming, `reasoning_content` deltas, and tool-call schemas are handled upstream by `@ai-sdk/openai-compatible` — not reimplemented here.

</details>

<details>
<summary><strong>Relationship to potential upstream fixes</strong></summary>

Two upstream changes would narrow the gap, but neither would make this plugin redundant:

- **If Moonshot routes `sk-kimi-...` keys to K2.6**, opencode's built-in path reaches K2.6 too, but still without `prompt_cache_key` or the paired reasoning fields. Explicit session-scoped cache reuse stays unavailable on that path (any automatic prefix caching Moonshot may do is orthogonal and would apply to both paths), and reasoning is controlled on the Anthropic route via `thinking.budget_tokens` — the paired `reasoning_effort: low|medium|high` knob that kimi-cli exposes has no equivalent there.
- **If opencode ships a native Kimi For Coding OAuth**, the auth story converges, but the request-field gap stays until opencode's provider code emits these exact fields for `/coding`. kimi-cli is Moonshot's first-party client and targets the OpenAI-compatible route, so mirroring its wire shape is the lowest-risk way to stay aligned with upstream. Fingerprint parity (same `X-Msh-Device-Id` and headers, kimi-cli-shaped UA) and independent refresh-token chains are unlikely to be replicated by a first-party integration.

</details>

<details>
<summary><strong>Request fields in detail</strong></summary>

| Field | Wire shape | Purpose |
|---|---|---|
| `prompt_cache_key` | top-level body, snake_case, set to opencode's `sessionID` | Opt-in, session-scoped cache key, mirroring kimi-cli. |
| `thinking` + `reasoning_effort` | `thinking: { type: "enabled" \| "disabled" }` with sibling `reasoning_effort: "low" \| "medium" \| "high"` | Sent together, matching kimi-cli. |
| Seven `X-Msh-*` headers + UA | `User-Agent`, `X-Msh-Platform`, `X-Msh-Version`, `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Device-Id`, `X-Msh-OS-Version` | Matches kimi-cli's `_kimi_default_headers()` at the pinned `KIMI_CLI_VERSION`. |
| `~/.kimi/device_id` | UUID persisted on disk, embedded in `X-Msh-Device-Id` | Sends the same `X-Msh-Device-Id` as a locally-installed kimi-cli. |

Effort-to-field mapping, taken verbatim from kimi-cli:

| user effort | `reasoning_effort` | `thinking` |
|---|---|---|
| `auto` | *(omitted)* | *(omitted)* — server picks dynamically |
| `off` | *(omitted)* | `{ type: "disabled" }` |
| `low` / `medium` / `high` | same string | `{ type: "enabled" }` |

</details>

<details>
<summary><strong>Files the plugin touches</strong></summary>

| Path | Purpose |
|---|---|
| `~/.kimi/device_id` | Stable UUID used in `X-Msh-Device-Id`. Shared with kimi-cli. |
| `<opencode data>/auth.json` | Token storage, managed by opencode through `client.auth.*`. |

No other state is persisted. Credentials are never written to `~/.kimi/credentials/`; that path belongs to kimi-cli, and sharing it would cause refresh-token races between the two clients.

</details>

<details>
<summary><strong>Architecture at a glance</strong></summary>

```
┌────────────── opencode core ─────────────┐
│                                          │
│  auth.login ─▶ plugin.auth.authorize()   │  device-code flow, poll
│                 └─▶ oauth.ts             │
│                                          │
│  chat ──────▶ plugin.loader()            │  custom fetch that:
│                 ├─▶ ensureFresh()        │   • proactive refresh
│                 └─▶ kimiHeaders()        │   • 7 X-Msh-* headers
│                                          │   • 401 → force-refresh + retry
│  chat.params ─▶ plugin "chat.params"     │  thinking / reasoning_effort /
│                                          │  prompt_cache_key
└──────────────────────────────────────────┘
```

A full description of the invariants that keep this working is in [`AGENTS.md`](./AGENTS.md), under "Architecture" and "Contracts to keep intact".

</details>

### License

MIT.
