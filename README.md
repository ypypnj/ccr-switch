# ccr-switch v2.4.3

Multi-provider model routing for [Claude Code](https://claude.ai/code). A standalone Node.js proxy -- zero external dependencies -- that maps Claude wire model names to configurable upstream providers via Anthropic-compatible endpoints.

## Architecture

```
Claude Code  →  127.0.0.1:$PORT  →  proxy.js  →  upstream provider
                     (--config config.json)         (ds/mm/xa/...)
```

- **v2.4.3**: Captures streaming and non-streaming message IDs before returning HTTP 200, stores execution receipts, and fails closed when a receipt cannot be recorded.
- **v2.4.2**: Fixes atomic PID-state publication after a healthy proxy start.
- **v2.4.1**: Runs as a single `proxy.js` file using only Node.js built-ins (`http`, `https`, `fs`, `crypto`).
- Provider endpoints, API keys, model aliases, and routing bindings all live in one JSON config file.
- No silent fallback: every model must be explicitly configured.

## Quick Start

```bash
bash /root/ese-project/ccr-switch/install.sh
```

The installer will:
1. Prompt for the `xa` provider API key (other providers configured separately).
2. Atomically generate `~/.config/ccr-switch/config.json` (mode `0600`) and `credentials.json` (mode `0600`).
3. Deploy proxy.js and control scripts to `~/.local/share/ccr-switch/`.
4. Start the proxy on port 3456.

Set environment variables to route Claude Code through the proxy:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_AUTH_TOKEN=any-string-is-ok
```

## CLI

```
node proxy.js --config <path> --port <port>
```

Both `--config` and `--port` are required. The config file is validated at startup (schema, duplicate names, dangling bindings, placeholder keys).

## Config -- Single Source of Truth

All provider endpoints, keys, model aliases, and routing rules live in `config.json`. See `config.example.json` for the template.

### Providers

Each provider declares its endpoint, key, and a short-name to upstream-model mapping:

```jsonc
{
  "Providers": [
    {
      "name": "ds",
      "api_base_url": "https://api.deepseek.com/anthropic/v1/messages",
      "api_key": "sk-...",
      "models": { "v4pro": "deepseek-v4-pro", "v4flash": "deepseek-v4-flash" }
    }
  ]
}
```

Short name format for requesting a model: `<provider>,<alias>` (e.g. `ds,v4pro`).

### ModelBindings -- Verifiable Model Delegation

`ModelBindings` is the primary routing mechanism. When a Claude wire model maps to a binding, that target is used. `ModelBindings` may be empty (`{}`) -- in that case only explicit `provider,alias` (or a globally unique bare alias) routes successfully.

Both exact and wildcard patterns are supported:

```jsonc
{
  "ModelBindings": {
    "claude-haiku-*":  "ds,v4flash",
    "claude-sonnet-*":  "ds,v4pro",
    "claude-opus-*":   "xa,gpt5.6",
    "claude-fable-*":  "xa,gpt5.6"
  }
}
```

Rules:
- **ModelBindings takes priority**: exact match wins over wildcard; longest wildcard prefix wins when multiple patterns overlap.
- When no binding matches, the wire model is parsed as `provider,alias` directly -- if the provider and alias both exist, the request is routed. A globally unique bare alias (matching exactly one provider alias) is also accepted. Any other form returns 400 `unknown_model`.
- A binding target must reference a real provider+model pair (validated at startup).
- Changing a mapping target (e.g. pointing `claude-haiku-*` to a different provider) requires only a config edit and proxy restart -- no code changes.

### Resolution Flow

```
wire model from request
  → check ModelBindings (exact, then longest wildcard prefix)
    → if found: use the bound target (provider,model)
    → if not found: parse wire model as "provider,model" directly
      → if valid provider+model pair: use it
    → if not found: try as globally unique bare alias
      → if exactly one provider has this alias: use it
      → else: 400 unknown_model
```

There is no implicit fallback to a default provider. Unknown models return HTTP 400.

## Dispatch Receipt

When the requested model is successfully resolved, the response includes headers that form a verifiable dispatch receipt. Responses for unknown/malformed models (400 `unknown_model`) do not carry a resolved receipt.

| Header | Meaning |
|---|---|
| `X-CCR-Dispatch-Id` | Unique request ID (24 hex chars) |
| `X-CCR-Requested-Model` | Wire model as received |
| `X-CCR-Resolved-Provider` | Provider short name that handled the request |
| `X-CCR-Resolved-Model` | Actual upstream model name |
| `X-CCR-Config-Fingerprint` | SHA-256 of provider and binding config (verifies config identity) |

## Error Classification

All errors are classified by type, with no silent fallback:

| HTTP | Error Type | Meaning |
|---|---|---|
| 400 | `unknown_model` | Model not found in any provider or binding |
| 429 | `provider_rate_limited` | Upstream returned 429; provider enters 30s cool-down |
| 503 | `provider_circuit_open` | Provider in cool-down; all requests blocked for 30s |
| 503/529 | `provider_overloaded` | Upstream returned 503/529; same cool-down behavior |
| 502 | `provider_network_error` | TCP connection to upstream failed |
| varies | `upstream_error` | Non-SSE error from upstream (non-streaming path) |

**Provider isolation**: when one provider enters circuit-open, other providers continue to serve requests normally. Each provider maintains an independent cool-down timer.

## Supported Providers

| Provider | Short | Models | Thinking |
|---|---|---|---|
| DeepSeek | `ds,v4pro` / `ds,v4flash` | deepseek-v4-pro, deepseek-v4-flash | thinking cache round-trip |
| MiniMax | `mm,m3` | MiniMax-M3 | extended thinking auto-injected |
| xapex | `xa,gpt5.6` | gpt-5.6-sol | passthrough (non-thinking) |

## Endpoints

| Path | Method | Description |
|---|---|---|
| `/v1/messages` | POST | Forward to resolved upstream and record its message-ID execution receipt |
| `/v1/receipts/by-message-id/:id` | GET | Retrieve a process-local execution receipt (loopback clients only) |
| `/v1/models` | GET | List all available provider+model pairs |
| `/health` | GET | Health check (`{"status":"ok"}`) |

## Control Scripts

Deployed to `~/.local/share/ccr-switch/scripts/`:

| Command | Purpose |
|---|---|
| `ccr-switch-on` | Start proxy (nohup or systemd user unit) |
| `ccr-switch-off` | Stop proxy (by PID identity check or systemd) |
| `ccr-switch-status` | Health check via `/health` endpoint |

## Install Safety

- **Symlink attack prevention**: All directory and file paths are validated before any mutation (no symlinks, correct owner, correct type).
- **Atomic config generation**: Credentials and config are staged in temporary files, then `mv`-renamed atomically.
- **Transaction-based rollback**: If any step fails mid-install, old files are restored from backup using inode identity verification.
- **Permission enforcement**: Config dir `0700`, config and credentials files `0600` throughout.
- **Lock-based concurrency**: Install script uses a mutual-exclusion directory lock with stale detection.
- **Placeholder guard**: proxy.js refuses to start if any provider API key contains placeholder strings.
- **Zero secrets in repo**: No API keys or credentials are committed to the repository.

## License

MIT
