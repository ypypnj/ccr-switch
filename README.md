# ccr-switch v2.0.0

Multi-provider model switching for Claude Code. DeepSeek V4 Pro / V4 Flash + MiniMax M2.7.

## Architecture

```
Claude Code  --http-->  proxy.js (127.0.0.1:3456)
                             |
              +--------------+--------------+
              |              |              |
      DeepSeek V4 Pro  DeepSeek V4 Flash  MiniMax M2.7
      (ds,v4pro)       (ds,v4flash)       (mm,m2.7)
```

Standalone ~220 line Node.js proxy. Zero external dependencies.

## Quick Start

```bash
git clone https://github.com/ypypnj/ccr-switch.git
cd ccr-switch
# Edit proxy.js with your API keys
node proxy.js 3456 &
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_AUTH_TOKEN=any-string-is-ok
```

## Models & Thinking

| Model | Route | Thinking | Effort |
|-------|-------|----------|--------|
| /model ds,v4pro | default, think | enabled (adaptive->enabled) | high (default) |
| /model ds,v4flash | background | enabled (adaptive->enabled) | high (default) |
| /model mm,m2.7 | Manual switch | native | high (default) |

- Thinking: enabled by default for all models
- Effort: defaults to `high`, maps to DeepSeek `high`/`max` levels
- User can override effort via Claude Code `/effort` command

## Dynamic Model Switching

`/model` works within the same conversation. No tmux restart needed.

## Format Fixes

| Fix | Description |
|-----|-------------|
| System role | Moves `role:"system"` from messages array to top-level `system` field |
| Adaptive thinking | Converts `thinking:{type:"adaptive"}` to `{type:"enabled",budget_tokens:N}` |
| Default effort | Sets `output_config.effort:"high"` when not specified |
| Thinking cache | FIFO queue: extracts thinking blocks from streaming responses, re-injects into next request |
| Signature replace | Replaces DeepSeek-specific thinking signatures with generic ones |

## Token Cost

Thinking blocks are part of DeepSeek responses and MUST be passed back for multi-turn conversations. The proxy restores what Claude Code strips. No additional token cost beyond normal thinking mode usage.

## Files

| File | Purpose |
|------|---------|
| proxy.js | Standalone proxy — all logic |
| config.example.json | Legacy ccr config |
| patch.js | Legacy ccr patches |
