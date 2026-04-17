## opencode-kimi-full

An [opencode](https://opencode.ai) plugin that adds a Kimi For Coding OAuth provider.

This plugin:

- uses the official Kimi device flow against `https://auth.kimi.com` with `scope: kimi-code`
- talks to `https://api.kimi.com/coding/v1` through `@ai-sdk/openai-compatible`
- sends the same `User-Agent` / `X-Msh-*` fingerprint headers as `kimi-cli`
- reuses `~/.kimi/device_id` for `X-Msh-Device-Id`
- adds `prompt_cache_key`, `thinking`, and `reasoning_effort` for `kimi-for-coding` requests

This is the K2.6 / `kimi-for-coding` OAuth path: Moonshot routes static `sk-kimi-...` API keys to K2.5, and OAuth tokens with `scope: kimi-code` to K2.6.

Contributor and agent documentation lives in [`AGENTS.md`](./AGENTS.md).

---

### Requirements

- `opencode` ≥ 1.4.6
- A Kimi account with an active **Kimi For Coding** subscription (the same plan that works with kimi-cli)

### Install

```sh
opencode plugin opencode-kimi-full --global
```

That installs the plugin through opencode and adds it to your global config.

Or add the package name to the `plugin` list in `~/.config/opencode/opencode.json` or a project-local `.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-kimi-full"]
}
```

<details>
<summary>From a local checkout</summary>

Point the `plugin` entry at the repo root instead of the npm package name:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-kimi-full"]
}
```

</details>

### Configure

After the plugin is installed, add a provider entry in `~/.config/opencode/opencode.json` or `.opencode/opencode.json`:

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
            "off":    { "reasoning_effort": "off" },
            "auto":   { "reasoning_effort": "auto" },
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
- **model id** `kimi-for-coding` — a stable opencode-side alias. At login and on every token refresh the plugin queries `/coding/v1/models` and rewrites the wire `model` field if the server reports a different slug for your account.

> **Note.** The provider id is intentionally not `kimi-for-coding`. That id is already published by [models.dev](https://models.dev) and points at a static-API-key flow using a different SDK and auth shape. Using a distinct id keeps the two paths from colliding under a single `opencode auth login` entry.

### Log in

```sh
opencode auth login -p kimi-for-coding-oauth
```

The plugin returns a verification URL and user code. After browser approval it polls the device-auth endpoint, queries `/coding/v1/models` to discover the current model id and context length for your account, prints a config snippet with that context length filled in, and stores the token plus discovered model metadata in opencode's auth store. Model discovery runs again on every token refresh. Access tokens refresh automatically, and the loader retries once after a `401`.

### Use

Select `kimi-for-coding-oauth/kimi-for-coding` in opencode.

The default variant-cycle keybind is **Ctrl+T**. The variants map as follows:

- `off` → sends `thinking: { "type": "disabled" }`
- `auto` → omits both `thinking` and `reasoning_effort`
- `low` / `medium` / `high` → send `thinking: { "type": "enabled" }` plus the matching `reasoning_effort`

---

<details>
<summary><strong>Why this plugin exists</strong></summary>

This plugin exists to bring the OAuth/device-flow `kimi-cli` path into opencode without sharing kimi-cli's credential files.

**What it changes.**

- OAuth device flow with `scope: kimi-code`.
- `@ai-sdk/openai-compatible` pointed at `https://api.kimi.com/coding/v1`.
- `prompt_cache_key` set to opencode's session id, for session-scoped cache reuse.
- Paired `thinking` + `reasoning_effort` fields.
- The seven `X-Msh-*` headers and a kimi-cli-shaped `User-Agent`.
- `~/.kimi/device_id` shared with a locally-installed kimi-cli.
- Tokens stored in opencode's auth store under a dedicated provider id, so the plugin and kimi-cli keep independent refresh-token chains and do not invalidate each other.
- Streaming, `reasoning_content` deltas, and tool-call schemas are handled upstream by `@ai-sdk/openai-compatible` — not reimplemented here.

</details>

<details>
<summary><strong>Request fields in detail</strong></summary>

| Field | Wire shape | Purpose |
|---|---|---|
| `prompt_cache_key` | top-level body, snake_case, set to opencode's `sessionID` | Opt-in, session-scoped cache key, mirroring kimi-cli. |
| `thinking` + `reasoning_effort` | `thinking: { type: "enabled" \| "disabled" }` with sibling `reasoning_effort: "low" \| "medium" \| "high"` | Sent together, matching kimi-cli. |
| Seven `X-Msh-*` headers + UA | `User-Agent`, `X-Msh-Platform`, `X-Msh-Version`, `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Device-Id`, `X-Msh-Os-Version` | Matches kimi-cli's `_kimi_default_headers()` at the pinned `KIMI_CLI_VERSION`. |
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
| opencode auth store (`auth.json` in opencode's XDG data dir; on Linux typically `~/.local/share/opencode/auth.json`) | Token storage, managed by opencode through `client.auth.*`. |

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
