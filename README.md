## opencode-kimi-full

An [opencode](https://opencode.ai) plugin for the **Kimi For Coding** plan. It authenticates the same way the official [`kimi` CLI](https://github.com/MoonshotAI/kimi-cli) does and mirrors its wire shape, so opencode requests to Moonshot's `/coding` endpoint match `kimi` CLI's byte-for-byte.

Contributor and agent documentation lives in [`AGENTS.md`](./AGENTS.md).

---

### Why this plugin exists

There are two ways to talk to Moonshot's Kimi For Coding plan today: the way `kimi` CLI does it, and the way opencode does it. They target different endpoints and use different authentication. This plugin brings the `kimi` CLI parity into opencode.

**How `kimi` CLI does it.** OAuth device-code flow against `auth.moonshot.cn` with `scope: kimi-code`, producing a short-lived JWT. Requests go to `https://api.kimi.com/coding/v1` (OpenAI-compatible) with the JWT as the bearer token, seven `X-Msh-*` fingerprint headers, a stable `~/.kimi/device_id`, and per-request extras: `prompt_cache_key` (an opt-in, session-scoped cache key) and paired `thinking.type` + `reasoning_effort` (sent together, matching `kimi` CLI). The backend routes this token to K2.6.

**How opencode does it.** `opencode auth login` selects a Kimi For Coding provider from the catalog and prompts for a `KIMI_API_KEY` (a static `sk-kimi-...` key). The catalog entry uses `@ai-sdk/anthropic` against `api.kimi.com/coding`, which is valid since the endpoint exposes both OpenAI-compatible and Anthropic-compatible routes for third-party agents. Authentication is the static key; no Kimi-specific request extras are sent (opencode's generic plumbing has no code path for `prompt_cache_key`, the paired `thinking` + `reasoning_effort` shape, or the `X-Msh-*` headers). The backend currently routes a static `sk-kimi-...` key to K2.5.

**What this plugin gives you.** Everything `kimi` CLI does, inside opencode. OAuth device flow with `scope: kimi-code` (so you land on K2.6, if you have access to it), `prompt_cache_key` set to the opencode session id, paired `thinking` + `reasoning_effort`, the seven `X-Msh-*` headers and `kimi`-CLI-shaped UA, and a `~/.kimi/device_id` shared with a locally-installed `kimi` CLI. Tokens are stored in opencode's `auth.json` under a dedicated `kimi-for-coding` provider id, so the plugin and `kimi` CLI keep independent refresh-token chains and do not invalidate each other. Streaming, `reasoning_content` deltas, and tool-call schemas are handled upstream by `@ai-sdk/openai-compatible` and are not reimplemented.

Two upstream changes would narrow the gap between the two paths. Even after both, the plugin remains a higher-fidelity alternative to opencode's built-in Kimi For Coding path:

- If Moonshot starts routing `sk-kimi-...` keys to K2.6, opencode's built-in path reaches K2.6 too, but still without `prompt_cache_key` or the paired reasoning fields. Explicit session-scoped cache reuse via `prompt_cache_key` stays unavailable on that path (any automatic prefix caching Moonshot may do is orthogonal and would apply to both paths), and reasoning is controlled on the Anthropic route via `thinking.budget_tokens` (a token budget); the paired `reasoning_effort: low|medium|high` knob that `kimi` CLI exposes has no equivalent there.
- If opencode ships a native Kimi For Coding OAuth, the auth story converges, but the request-field gap stays until opencode's provider code emits these exact fields for `/coding`. `kimi` CLI is Moonshot's first-party client and targets the OpenAI-compatible route, so mirroring its wire shape is the lowest-risk way to stay aligned with upstream. Fingerprint parity with `kimi` CLI (same `X-Msh-Device-Id` and headers as `kimi` CLI, `kimi`-CLI-shaped UA) and independent refresh-token chains are unlikely to be replicated by a first-party integration.

---

### Requirements

- `opencode` ≥ 1.4.6
- A Kimi account with an active **Kimi For Coding** subscription (the same plan that works with `kimi` CLI)

### Install

```sh
cd ~/.opencode
bun add opencode-kimi-full
```

From a local checkout:

```sh
cd ~/.opencode
bun add /path/to/opencode-kimi-full
```

### Configure

Add the plugin and a provider entry to `opencode.json` (or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-kimi-full"],
  "provider": {
    "kimi-for-coding": {
      "name": "Kimi K2.6 (for coding)",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.kimi.com/coding/v1"
      },
      "models": {
        "kimi-for-coding": {
          "name": "Kimi K2.6 Code Preview",
          "limit": { "context": 262144, "output": 32768 },
          "reasoning": true,
          "options": {}
        }
      }
    }
  }
}
```

Two identifiers are load-bearing and must not be renamed:

- the **provider id** `kimi-for-coding`. The plugin's `auth` and `chat.params` hooks match on it.
- the **model id** `kimi-for-coding`. Sent to Moonshot verbatim; do not strip the `kimi-` prefix.

### Log in

```sh
opencode auth login kimi-for-coding
```

The plugin returns a verification URL and user code. After browser approval it polls the device-auth endpoint and persists tokens through opencode's `auth.json`. Access tokens have a ~15 minute TTL and refresh automatically; refresh tokens last ~30 days.

### Use

Select `kimi-for-coding/kimi-for-coding` in opencode.

---

### Request fields in detail

| Field | Wire shape | Purpose |
|---|---|---|
| `prompt_cache_key` | top-level body, snake_case, set to opencode's `sessionID` | Opt-in, session-scoped cache key, mirroring `kimi` CLI. |
| `thinking` + `reasoning_effort` | `thinking: { type: "enabled" \| "disabled" }` with sibling `reasoning_effort: "low" \| "medium" \| "high"` | Sent together, matching `kimi` CLI. |
| Seven `X-Msh-*` headers + UA | `User-Agent`, `X-Msh-Platform`, `X-Msh-Version`, `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Device-Id`, `X-Msh-OS-Version` | Matches `kimi` CLI's `_kimi_default_headers()` at the pinned `KIMI_CLI_VERSION`. |
| `~/.kimi/device_id` | UUID persisted on disk, embedded in `X-Msh-Device-Id` | Sends the same `X-Msh-Device-Id` as a locally-installed `kimi` CLI. |

Effort-to-field mapping, taken verbatim from `kimi` CLI:

| user effort | `reasoning_effort` | `thinking.type` |
|---|---|---|
| `off` | *(omitted)* | `"disabled"` |
| `low` / `medium` / `high` | same string | `"enabled"` |

---

### Files the plugin touches

| Path | Purpose |
|---|---|
| `~/.kimi/device_id` | Stable UUID used in `X-Msh-Device-Id`. Shared with `kimi` CLI. |
| `<opencode data>/auth.json` | Token storage, managed by opencode through `client.auth.*`. |

No other state is persisted. Credentials are never written to `~/.kimi/credentials/`; that path belongs to `kimi` CLI, and sharing it would cause refresh-token races between the two clients.

### Architecture

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

### License

MIT.
