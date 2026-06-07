# ccr-switch v2.0.0

Multi-provider model switching for Claude Code. DeepSeek V4 Pro / V4 Flash + MiniMax M3.

## Architecture

```
Claude Code  --http-->  proxy.js (127.0.0.1:3456)
                             |
              +--------------+--------------+
              |              |              |
      DeepSeek V4 Pro  DeepSeek V4 Flash  MiniMax M3
      (ds,v4pro)       (ds,v4flash)       (mm,m3)
```

Standalone ~230 line Node.js proxy. Zero external dependencies. Replaces the previous ccr-based architecture.

## Quick Start

```bash
git clone https://github.com/ypypnj/ccr-switch.git
cd ccr-switch
# Edit proxy.js with your API keys
node proxy.js 3456 &
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_AUTH_TOKEN=any-string-is-ok
```

Add env vars to `~/.bashrc`. Add `@reboot` crontab for auto-start.

## Models

| Command | Provider | Model |
|---------|----------|-------|
| /model ds,v4pro | DeepSeek | V4 Pro |
| /model ds,v4flash | DeepSeek | V4 Flash |
| /model mm,m3 | MiniMax | M3 (thinking enabled) |

Chinese comma ( ，) auto-normalized to ASCII comma.

## What the Proxy Does

Minimal intervention — only handles what is strictly necessary:

| Fix | Why |
|-----|-----|
| System role → top-level | Claude Code v2.1.156 put system in messages (fixed in v2.1.158, kept as no-op safety net) |
| adaptive → enabled | DeepSeek Anthropic endpoint does not support adaptive thinking type |
| Chinese comma fix | `/model` input may use Chinese comma |
| /v1/models endpoint | Required for `/model` command validation |
| M3 thinking auto-enable | MiniMax M3 默认启用 extended thinking（budget_tokens=32000） |

## What the Proxy Does NOT Do

- No thinking block caching or injection (streaming cache disabled)
- No default effort override
- No signature rewriting

## Comparison with Direct Connection

| Aspect | Direct DeepSeek | Through Proxy |
|--------|----------------|---------------|
| thinking type | adaptive (native) | adaptive→enabled |
| effort | set by /effort | set by /effort |
| model switching | no | yes (3 providers) |
| thinking cost | same | same |

## Files

| File | Purpose |
|------|---------|
| proxy.js | Standalone proxy |
| config.example.json | Legacy ccr config |
| patch.js | Legacy ccr patches |

## 版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-06-07 | v1.2.0 | MiniMax M2.7 → M3 替换，M3 默认启用 extended thinking |
| 2026-05-30 | v1.1.0 | 修复 content-length 重新计算，Chinese comma 兼容 |
| 2026-05-26 | v1.0.0 | 初始版本，DeepSeek V4 Pro/Flash + MiniMax M2.7 |
