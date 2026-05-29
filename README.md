# ccr-switch v2.0.0

Multi-provider model switching for Claude Code.

DeepSeek V4 Pro / V4 Flash + MiniMax M2.7, via Anthropic-compatible endpoints with native thinking.

## Architecture

```
Claude Code  --http-->  proxy.js (127.0.0.1:3456)
                             |
              +--------------+--------------+
              |              |              |
      DeepSeek V4 Pro  DeepSeek V4 Flash  MiniMax M2.7
      (ds,v4pro)       (ds,v4flash)       (mm,m2.7)
      + thinking       fast mode          + native thinking
```

v2.0.0: Standalone ~200 line Node.js proxy. No external dependencies beyond Node.js built-ins. Replaces the previous ccr-based architecture which broke after Claude Code v2.1.153.

## Quick Start

```bash
git clone https://github.com/ypypnj/ccr-switch.git
cd ccr-switch
# Edit proxy.js with your API keys
node proxy.js 3456 &
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_AUTH_TOKEN=any-string-is-ok
```

## Models

| Command | Provider | Model | Thinking |
|---------|----------|-------|----------|
| /model ds,v4pro | DeepSeek | V4 Pro | adaptive->enabled |
| /model ds,v4flash | DeepSeek | V4 Flash | stripped |
| /model mm,m2.7 | MiniMax | M2.7 | native |

## Dynamic Model Switching

/model works within the same conversation. No need to restart tmux or Claude Code.

## Format Fixes

Claude Code v2.1.156 sends requests in a format that DeepSeek Anthropic endpoint rejects:

| Fix | Description |
|-----|-------------|
| System role | Moves role:"system" from messages array to top-level system field |
| Adaptive thinking | Converts thinking:{type:"adaptive"} to {type:"enabled",budget_tokens:16000} |
| Flash thinking | Strips thinking entirely for flash/haiku models |
| Signature replace | Replaces DeepSeek-specific thinking signatures with generic ones |
| Thinking cache | FIFO queue: caches thinking blocks from responses, re-injects into next request |

## Token Cost

Thinking blocks are part of DeepSeek responses and MUST be passed back for multi-turn conversations to work (without them DeepSeek returns HTTP 400). The proxy restores what Claude Code incorrectly strips. There is no additional token cost beyond normal thinking mode usage.

## Reasoning Quality

Cached blocks are DeepSeek own chain-of-thought from previous turns. Passing them back is REQUIRED by DeepSeek API for reasoning continuity across turns. The cache preserves reasoning quality — without it the API would fail.

## Files

| File | Purpose |
|------|---------|
| proxy.js | Standalone proxy — all logic in one file |
| config.example.json | Legacy ccr config |
| patch.js | Legacy ccr patches |
| install.sh | Legacy ccr installer |
