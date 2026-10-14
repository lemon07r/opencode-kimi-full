## opencode-kimi-full

An [opencode](https://opencode.ai) plugin that makes the Kimi Code path in opencode work like the official `kimi-cli`, using Kimi-specific extensions instead of just a generic OpenAI-compatible provider.

Compared with stock opencode Kimi setups, this plugin:

- uses the official Kimi device-flow OAuth against `https://auth.kimi.com`
- talks to `https://api.kimi.com/coding/v1` through `@ai-sdk/openai-compatible`
- sends the same `User-Agent` / `X-Msh-*` fingerprint headers as `kimi-cli`
- reuses `~/.kimi/device_id` for `X-Msh-Device-Id`
- adds `prompt_cache_key`, `thinking`, and `reasoning_effort` for Kimi Code requests
- syncs the full model list from `/coding/v1/models` at every startup (server-first; the last-known-good cache only covers failed queries), so newly released Kimi Code models appear in the picker without a plugin update or config edits
- discovers the authoritative wire model slug, display name, context length, and media-input capabilities from `/coding/v1/models` (`attachment`/`modalities` are omitted when the server reports `supports_image_in: false`)
- keeps tokens in opencode's auth store while mirroring `kimi-cli`'s refresh / retry behavior
- provides a `/kimi:usage` TUI command to check subscription usage

Contributor and agent documentation lives in [`AGENTS.md`](./AGENTS.md).

---

### Quick Start

1. Install the plugin globally: `opencode plugin opencode-kimi-full --global`
2. If you are testing a local checkout instead of the published package, install the checkout path instead: `opencode plugin /absolute/path/to/opencode-kimi-full --global`
3. Run `opencode auth login -p kimi-for-coding-oauth` and approve the device flow in your browser.
4. Select any model under `kimi-for-coding-oauth/` in opencode. The provider entry and its model list are injected automatically at startup — no manual config block is required. See [Configure](#configure) only if you want to override something.

### Requirements

- `opencode` >= 1.4.6
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

You normally don't need this section. At every startup the plugin:

1. reads the stored OAuth token,
2. queries `/coding/v1/models` for the authoritative model list of your account,
3. injects the `kimi-for-coding-oauth` provider entry and one config entry per discovered model into opencode's runtime config (merging with — never overwriting — anything you wrote yourself).

If the discovery call fails, degradation is graceful and visible: the plugin falls back to the **last-known-good model list** (persisted next to your auth store in `kimi-for-coding-oauth.models.json`) and logs one actionable warning — including an HTTP 402 "membership check failed" hint when your Kimi Code subscription lapsed. If there is no cache either (fresh install, offline, never logged in), **nothing is injected** — the plugin never invents model entries. This mirrors kimi-cli (no static list at all) and opencode core's gitlab `discoverModels`, which returns nothing on failure; plugins that hardcode model tables do so only because their upstream lacks a discovery endpoint, which is not the case for Kimi.

#### Naming: what you see is what you write (v1.6.0+)

The model key shown in the opencode picker is **exactly** the string you reference from agent files and `opencode.json`:

```yaml
model: kimi-for-coding-oauth/Kimi K3        # ← the key IS the picker label
```

Keys are derived from the server's `display_name`; the raw server slug (`k3`) rides on the wire automatically via each entry's `id` field (opencode resolves wire ids through it), so you never deal with slugs unless you want to — referencing `kimi-for-coding-oauth/k3` directly also still works.

> **Migrating from v1.5.x:** replace raw-slug references with display names — `kimi-for-coding-oauth/kimi-for-coding` → `kimi-for-coding-oauth/Kimi For Coding`, `kimi-for-coding-oauth/k3` → `kimi-for-coding-oauth/Kimi K3`. Old manual provider blocks can simply be deleted; the plugin injects everything itself.

Add a config block only to **override** generated entries — under the same display-name key. Your keys win per-field; everything else stays generated:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "kimi-for-coding-oauth": {
      "models": {
        "Kimi K3": {
          "name": "Kimi K3 (mine)",
          "variants": {
            "max": { "reasoning_effort": "max" }
          }
        }
      }
    }
  }
}
```

Generated model entries look like this (shown for reference; `context` comes from the server, `output` is a conservative `65536`):

```json
{
  "Kimi K3": {
    "id": "k3",
    "name": "Kimi K3",
    "attachment": true,
    "reasoning": true,
    "limit": { "context": 1048576, "output": 65536 },
    "modalities": {
      "input": ["text", "image"],
      "output": ["text"]
    },
    "options": {},
    "variants": {
      "off":    { "reasoning_effort": "off" },
      "auto":   { "reasoning_effort": "auto" },
      "low":    { "reasoning_effort": "low" },
      "medium": { "reasoning_effort": "medium" },
      "high":   { "reasoning_effort": "high" },
      "max":    { "reasoning_effort": "max" }
    }
  }
}
```

> **Important:** The generated `attachment` and `modalities` fields are what make image input work — opencode strips image parts before they reach Kimi without them. The plugin injects them from the server's `supports_image_in` / `supports_video_in` flags; if you fully replace a model entry in your own config, keep those fields.

The **provider id** `kimi-for-coding-oauth` is fixed -- the plugin's `auth` and chat hooks match on it. **Model keys** come from the server's `display_name`; the plugin rewrites the wire `model` field to the server-reported slug on every request (belt to the `id` field's suspenders), and models the server starts returning appear under their names after the next restart.

> **Note.** The provider id is intentionally not `kimi-for-coding`. That id is already published by [models.dev](https://models.dev) and points at a static-API-key flow using a different SDK and auth shape. Using a distinct id keeps the two paths from colliding under a single `opencode auth login` entry.

### Log in

```sh
opencode auth login -p kimi-for-coding-oauth
```

Then complete the device-flow approval in your browser.

During login the plugin:

- shows a verification URL and user code
- stores the OAuth token in opencode's auth store
- discovers the exact model slugs, display names, context lengths, and media-input capabilities your account is entitled to
- prints the discovered model list; the models themselves are injected into the config automatically at the next startup

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
<summary><strong>Troubleshooting: Images not working / "this model does not support image input"</strong></summary>

opencode gates image input on model metadata. If a model entry is missing `attachment: true` and `modalities`, opencode strips image parts before they reach Kimi.

The plugin generates these fields for every model it injects (from the server's `supports_image_in` / `supports_video_in` flags), so this should not happen with auto-injected entries. If you replaced a model entry in your own config block, add `"attachment": true` and `"modalities": { "input": ["text", "image"], "output": ["text"] }` to it.

The plugin also backfills these capabilities at runtime from `/coding/v1/models` discovery, but the static config must be correct for the initial request.

</details>

<details>
<summary><strong>Login and refresh details</strong></summary>

- The plugin queries `/coding/v1/models` at startup, during login, and on every token refresh so it always works with the account's current model entitlement: wire model ids, context lengths, and media capabilities.
- The startup response feeds the config injection described in [Configure](#configure) — this is how newly released Kimi Code models appear in the picker without a plugin update.
- The plugin uses the same discovery response to backfill image and video input support into opencode's runtime model metadata, so pasted or dropped images reach Kimi instead of being downgraded into local error text.
- Generated config entries carry `limit.context` from the server-reported `context_length` (`256_000` default when the server omits it) and a conservative `output` limit of `65536`.
- On a `401`, the loader refreshes the access token once and retries the request once.
- Refreshes are coordinated through opencode's live auth store so concurrent workspaces do not keep using an older refresh-token chain from a stale `OPENCODE_AUTH_CONTENT` snapshot.

</details>

### Use

Select any model under `kimi-for-coding-oauth/` in opencode (`k3`, `kimi-for-coding`, `kimi-for-coding-highspeed`, or whatever the server currently returns for your account).

The default variant-cycle keybind is **Ctrl+T**. The variants map as follows:

- `off` -- sends `thinking: { "type": "disabled" }`
- `auto` -- omits both `thinking` and `reasoning_effort`
- `low` / `medium` / `high` / `max` -- send `thinking: { "type": "enabled" }` plus the matching `reasoning_effort`

These variants only affect Kimi's reasoning request fields. They do not switch models or auth paths. In practice:

- `off` asks the backend to disable thinking
- `auto` leaves the decision to the server
- `low` / `medium` / `high` ask for enabled thinking with the corresponding reasoning effort
- `max` asks for the highest reasoning effort. It passes through only for models whose discovery payload advertises it via `think_efforts.valid_efforts` (currently `k3` and `k3-256k`); for everything else — including K2.7 models and models the server says nothing about — it is clamped to `high`, because an unsupported effort value fails the request upstream.
- `xhigh` is clamped to `high` for all models.

Every Kimi Code request also gets `prompt_cache_key` set to opencode's session id. That mirrors `kimi-cli`'s cache hint so follow-up turns in the same session can reuse Kimi's prompt cache.

#### Usage command

The plugin registers a `/kimi:usage` TUI slash command that shows your Kimi Code subscription usage (weekly and rolling-window limits) in a compact dialog. Run it from the opencode command palette.

---

<details>
<summary><strong>Why this plugin exists</strong></summary>

Stock opencode can already talk to generic Moonshot and OpenAI-compatible endpoints. This plugin exists for the Kimi Code path specifically: it brings the official Kimi OAuth flow and Kimi-specific request behavior into opencode without sharing `kimi-cli`'s credential files.

**What it adds over the generic route.**

- OAuth device flow against `https://auth.kimi.com`.
- `@ai-sdk/openai-compatible` pointed at `https://api.kimi.com/coding/v1`.
- `prompt_cache_key` set to opencode's session id, for session-scoped cache reuse.
- Paired `thinking` + `reasoning_effort` fields, with effort clamping to match kimi-cli.
- The seven `X-Msh-*` headers and a kimi-cli-shaped `User-Agent`.
- `~/.kimi/device_id` shared with a locally-installed kimi-cli.
- Runtime model discovery from `/coding/v1/models`, including the server-reported wire slug, `display_name`, `context_length`, and media-input capabilities.
- Startup model sync that injects the provider entry and the discovered model list into opencode's config, so new Kimi Code models appear without a plugin update.
- Tokens stored in opencode's auth store under a dedicated provider id, so the plugin and kimi-cli keep independent refresh-token chains and do not invalidate each other.
- Live auth-store rereads plus a provider-scoped refresh lock, so concurrent opencode workspaces converge on the latest refresh-token chain instead of tripping `invalid_grant`.
- Streaming, `reasoning_content` deltas, and tool-call schemas are handled upstream by `@ai-sdk/openai-compatible` -- not reimplemented here.

</details>

<details>
<summary><strong>Request fields in detail</strong></summary>

| Field | Wire shape | Purpose |
|---|---|---|
| `prompt_cache_key` | top-level body, snake_case, set to opencode's `sessionID` | Opt-in, session-scoped cache key, mirroring kimi-cli. |
| `thinking` + `reasoning_effort` | `thinking: { type: "enabled" \| "disabled" }` with sibling `reasoning_effort: "low" \| "medium" \| "high" \| "max"` | Sent together, matching kimi-cli. `max` passes for models advertising it in `think_efforts.valid_efforts` (k3, k3-256k), clamped to `high` otherwise; `xhigh` clamped to `high`. Both fields are omitted entirely when discovery reports `supports_reasoning: false`. |
| Seven `X-Msh-*` headers + UA | `User-Agent`, `X-Msh-Platform`, `X-Msh-Version`, `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Device-Id`, `X-Msh-Os-Version` | Matches kimi-cli's `_common_headers()` at the pinned `KIMI_CLI_VERSION`. |
| `/coding/v1/models` discovery | `id`, `display_name`, `context_length`, `supports_image_in`, `supports_video_in` | Supplies the authoritative wire model slug plus runtime model metadata. |
| `~/.kimi/device_id` | UUID persisted on disk, embedded in `X-Msh-Device-Id` | Sends the same `X-Msh-Device-Id` as a locally-installed kimi-cli. |

Effort-to-field mapping used by the plugin:

| user effort | `reasoning_effort` | `thinking` | model |
|---|---|---|---|
| `auto` | *(omitted)* | *(omitted)* -- server picks dynamically | any, unless `supports_thinking_type: "only"` |
| `off` | *(omitted)* | `{ type: "disabled" }` | any, unless `supports_thinking_type: "only"` |
| `low` / `medium` / `high` | same string | `{ type: "enabled" }` | any |
| `max` | `max` | `{ type: "enabled" }` | models advertising `max` in `think_efforts.valid_efforts` (k3, k3-256k) |
| `max` | `"high"` (clamped) | `{ type: "enabled" }` | models whose discovery payload does not advertise `max` (K2.7 generation, anything unlisted) |
| `xhigh` | `"high"` (clamped) | `{ type: "enabled" }` | any |
| tier not advertised (e.g. `medium` on k3) | *(omitted — server applies its `default_effort`)* | `{ type: "enabled" }` | models enumerating `think_efforts.valid_efforts` |
| `off` / `auto` / unset | *(omitted)* | `{ type: "enabled" }` | `supports_thinking_type: "only"` models (all current Kimi Code models) |

The picker tier ladder itself is server-driven: when a model enumerates `think_efforts.valid_efforts`, only those tiers (plus `off`/`auto`) are offered as variants — so the picker never advertises a tier the server would reject (k3 has no `medium`).

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
                      opencode core
 ──────────────────────────────────────────────────
  startup ─────> plugin "config"             /models discovery →
                                               inject provider + model list

  auth.login ──> plugin.auth.authorize()     device-code flow, poll
                   └──> oauth.ts

  chat ────────> plugin.loader()             custom fetch that:
                   ├──> ensureFresh()          proactive refresh
                   └──> kimiHeaders()          7 X-Msh-* headers
                                               /models slug discovery
                                               401 -> force-refresh + retry

  chat.params ─> plugin "chat.params"        thinking / reasoning_effort /
                                              prompt_cache_key

  /kimi:usage ─> tui.tsx                     subscription usage dialog
                   └──> usage.ts
```

A full description of the invariants that keep this working is in [`AGENTS.md`](./AGENTS.md), under "Architecture" and "Contracts to keep intact".

</details>

<details>
<summary><strong>Troubleshooting: opencode fails to start with "Model not found: kimi-for-coding-oauth/…"</strong></summary>

Your config references a Kimi model (default `model`, an agent, etc.) while the plugin has no model list yet — no successful `/models` sync and no cache. Since v1.7.1 the `config` hook repairs this automatically: every `<provider>/<key>` reference found in the runtime config gets a minimal placeholder entry (key doubles as the wire id, requests fail upstream until a real sync lands), so startup can no longer die on dangling references. A warning in the log lists exactly which keys were synthesized and why.

If you are still on v1.7.0, upgrade the plugin — or temporarily point `model` at another provider.

</details>

### License

MIT.
