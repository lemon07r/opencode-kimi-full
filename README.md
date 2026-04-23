## opencode-kimi-full

An [opencode](https://opencode.ai) plugin that extends the Kimi Code path in opencode work like the official `kimi-cli` and make use of it's Kimi-specific extensions, instead of just working like a generic OpenAI-compatible provider.

Compared with stock opencode Kimi setups, this plugin:

- uses the official Kimi device flow against `https://auth.kimi.com` with `scope: kimi-code`
- talks to `https://api.kimi.com/coding/v1` through `@ai-sdk/openai-compatible`
- sends the same `User-Agent` / `X-Msh-*` fingerprint headers as `kimi-cli`
- reuses `~/.kimi/device_id` for `X-Msh-Device-Id`
- adds `prompt_cache_key`, `thinking`, and `reasoning_effort` for `kimi-for-coding` requests
- discovers the authoritative wire model slug, API display name, context length, and image-input capability from `/coding/v1/models`
- keeps tokens in opencode's auth store while mirroring `kimi-cli`'s refresh / retry behavior

That is the value of using this plugin instead of a plain opencode provider entry: it preserves the Kimi-only OAuth path, fingerprint, and request extensions that the generic route does not.

Contributor and agent documentation lives in [`AGENTS.md`](./AGENTS.md).

---

### Quick Start

1. Install the plugin globally: `opencode plugin opencode-kimi-full --global`
2. If you are testing a local checkout instead of the published package, install the checkout path instead: `opencode plugin /absolute/path/to/opencode-kimi-full --global`
3. Run `opencode auth login -p kimi-for-coding-oauth` and approve the device flow in your browser.
4. Paste the provider block from [Configure](#configure) into your opencode config.
5. Select `kimi-for-coding-oauth/kimi-for-coding` in opencode.

### Requirements

- `opencode` ≥ 1.4.6
- A Kimi account with an active **Kimi For Coding** subscription (the same plan that works with kimi-cli)

### Install

Recommended:

```sh
opencode plugin opencode-kimi-full --global
```

That installs the published package and adds the plugin to your global opencode config, so `opencode auth login -p kimi-for-coding-oauth` works from any directory.

From a local checkout:

```sh
opencode plugin /absolute/path/to/opencode-kimi-full --global
```

That is the command you want when you are editing this repo and want opencode to load your working tree. Changing files in a checkout does nothing unless opencode is pointed at that checkout path.

If you prefer managing plugin registration manually, add the plugin to the `plugin` list in `~/.config/opencode/opencode.json` or a project-local `.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-kimi-full"]
}
```

For a local checkout, point the `plugin` entry at the repo root instead of the npm package name:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-kimi-full"]
}
```

If you use a project-local `.opencode/opencode.json`, the plugin only exists when you run `opencode` inside that project tree. If you want `opencode auth login` to work from anywhere, use the `--global` install above.

### Configure

After the plugin is installed and login works, paste this provider entry into `~/.config/opencode/opencode.json` or `.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
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

This block is for using the model after login. It does **not** register the auth provider by itself. What makes `opencode auth login -p kimi-for-coding-oauth` work is the plugin being loaded via `opencode plugin ...` or the `plugin` array above.

Use these two ids exactly as written:

- **provider id** `kimi-for-coding-oauth` — the plugin's `auth` and `chat.params` hooks match on it.
- **model id** `kimi-for-coding` — a stable opencode-side alias. At login and on every token refresh the plugin queries `/coding/v1/models` and rewrites the wire `model` field if the server reports a different slug for your account.

> **Note.** The provider id is intentionally not `kimi-for-coding`. That id is already published by [models.dev](https://models.dev) and points at a static-API-key flow using a different SDK and auth shape. Using a distinct id keeps the two paths from colliding under a single `opencode auth login` entry.

### Log in

```sh
opencode auth login -p kimi-for-coding-oauth
```

Then complete the device-flow approval in your browser.

During login the plugin:

- shows a verification URL and user code
- stores the OAuth token in opencode's auth store
- discovers the exact model slug, display name, context length, and image-input capability your account should send to Kimi
- prints a config hint that uses the discovered display name and leaves context backfill to runtime metadata discovery

Access tokens refresh automatically while you use the model.

<details>
<summary><strong>Troubleshooting: Unknown provider "kimi-for-coding-oauth"</strong></summary>

That error means opencode did not load this plugin at all. The Kimi OAuth flow has not started yet.

The usual causes are:

- You skipped `opencode plugin opencode-kimi-full --global` or `opencode plugin /absolute/path/to/opencode-kimi-full --global`.
- You edited a local checkout, but opencode is not pointed at that checkout path.
- You put the plugin in a project-local `.opencode/opencode.json`, but ran `opencode auth login` from another directory.
- You added the `provider` block, but not the `plugin` entry or plugin install.

Fastest fix:

1. Install the plugin globally with `opencode plugin opencode-kimi-full --global`, or `opencode plugin /absolute/path/to/opencode-kimi-full --global` for a checkout.
2. Confirm your opencode config now contains the plugin entry.
3. Run `opencode auth login -p kimi-for-coding-oauth` again.

</details>

<details>
<summary><strong>Login and refresh details</strong></summary>

- The plugin queries `/coding/v1/models` during login so it can discover the current wire model id and context length for your account.
- The plugin also uses that discovery response to backfill image-input support into opencode's runtime model metadata, so pasted or dropped images reach Kimi instead of being downgraded into local error text.
- The printed config hint intentionally omits `limit`, because opencode requires both `limit.context` and `limit.output`, while Kimi's models endpoint only exposes `context_length`.
- Model discovery runs again on every token refresh, and a fresh loader instance can re-query `/coding/v1/models` on first use if it needs the current wire model id.
- On a `401`, the loader refreshes the access token once and retries the request once.
- Refreshes are coordinated through opencode's live auth store so concurrent workspaces do not keep using an older refresh-token chain from a stale `OPENCODE_AUTH_CONTENT` snapshot.

</details>

### Use

Select `kimi-for-coding-oauth/kimi-for-coding` in opencode.

The default variant-cycle keybind is **Ctrl+T**. The variants map as follows:

- `off` → sends `thinking: { "type": "disabled" }`
- `auto` → omits both `thinking` and `reasoning_effort`
- `low` / `medium` / `high` → send `thinking: { "type": "enabled" }` plus the matching `reasoning_effort`

These variants only affect Kimi's reasoning request fields. They do not switch models or auth paths. In practice:

- `off` asks the backend to disable thinking
- `auto` leaves the decision to the server
- `low` / `medium` / `high` ask for enabled thinking with the corresponding reasoning effort

The exact behavioral difference between `low`, `medium`, and `high` is controlled by Kimi's backend, so this should be read as a server hint rather than a guaranteed latency/quality ladder.

Every `kimi-for-coding` request also gets `prompt_cache_key` set to opencode's session id. That mirrors `kimi-cli`'s cache hint so follow-up turns in the same session can reuse Kimi's prompt cache.

---

<details>
<summary><strong>Why this plugin exists</strong></summary>

Stock opencode can already talk to generic Moonshot and OpenAI-compatible endpoints. This plugin exists for the Kimi Code path specifically: it brings the official Kimi OAuth flow and Kimi-specific request behavior into opencode without sharing `kimi-cli`'s credential files.

**What it adds over the generic route.**

- OAuth device flow with `scope: kimi-code`.
- `@ai-sdk/openai-compatible` pointed at `https://api.kimi.com/coding/v1`.
- `prompt_cache_key` set to opencode's session id, for session-scoped cache reuse.
- Paired `thinking` + `reasoning_effort` fields.
- The seven `X-Msh-*` headers and a kimi-cli-shaped `User-Agent`.
- `~/.kimi/device_id` shared with a locally-installed kimi-cli.
- Runtime model discovery from `/coding/v1/models`, including the server-reported wire slug, `display_name`, and `context_length`.
- Tokens stored in opencode's auth store under a dedicated provider id, so the plugin and kimi-cli keep independent refresh-token chains and do not invalidate each other.
- Live auth-store rereads plus a provider-scoped refresh lock, so concurrent opencode workspaces converge on the latest refresh-token chain instead of tripping `invalid_grant`.
- Streaming, `reasoning_content` deltas, and tool-call schemas are handled upstream by `@ai-sdk/openai-compatible` — not reimplemented here.

</details>

<details>
<summary><strong>Request fields in detail</strong></summary>

| Field | Wire shape | Purpose |
|---|---|---|
| `prompt_cache_key` | top-level body, snake_case, set to opencode's `sessionID` | Opt-in, session-scoped cache key, mirroring kimi-cli. |
| `thinking` + `reasoning_effort` | `thinking: { type: "enabled" \| "disabled" }` with sibling `reasoning_effort: "low" \| "medium" \| "high"` | Sent together, matching kimi-cli. |
| Seven `X-Msh-*` headers + UA | `User-Agent`, `X-Msh-Platform`, `X-Msh-Version`, `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Device-Id`, `X-Msh-Os-Version` | Matches kimi-cli's `_kimi_default_headers()` at the pinned `KIMI_CLI_VERSION`. |
| `/coding/v1/models` discovery | `id`, `display_name`, `context_length` | Supplies the authoritative wire model slug plus runtime model metadata. |
| `~/.kimi/device_id` | UUID persisted on disk, embedded in `X-Msh-Device-Id` | Sends the same `X-Msh-Device-Id` as a locally-installed kimi-cli. |

Effort-to-field mapping used by the plugin:

| user effort | `reasoning_effort` | `thinking` |
|---|---|---|
| `auto` | *(omitted)* | *(omitted)* — server picks dynamically |
| `off` | *(omitted)* | `{ type: "disabled" }` |
| `low` / `medium` / `high` | same string | `{ type: "enabled" }` |

`kimi-cli` does not currently surface this as a separate user-facing level selector. The plugin exposes the same wire-level controls as opencode variants so you can choose them explicitly.

</details>

<details>
<summary><strong>Files the plugin touches</strong></summary>

| Path | Purpose |
|---|---|
| `~/.kimi/device_id` | Stable UUID used in `X-Msh-Device-Id`. Shared with kimi-cli. |
| opencode auth store (`auth.json` in opencode's XDG data dir; on Linux typically `~/.local/share/opencode/auth.json`) | Token storage, managed by opencode through `client.auth.*`; the plugin also live-reads this entry to avoid stale workspace auth snapshots during refresh. |

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
│                                          │   • /models slug + display_name discovery
│                                          │   • 401 → force-refresh + retry
│  chat.params ─▶ plugin "chat.params"     │  thinking / reasoning_effort /
│                                          │  prompt_cache_key
└──────────────────────────────────────────┘
```

A full description of the invariants that keep this working is in [`AGENTS.md`](./AGENTS.md), under "Architecture" and "Contracts to keep intact".

</details>

### License

MIT.
