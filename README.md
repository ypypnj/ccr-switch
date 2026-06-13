# ccr-switch v2.0.0

Multi-provider model switching for [Claude Code](https://claude.ai/code).

**DeepSeek V4 Pro / V4 Flash + MiniMax M2.7**, all via Anthropic-compatible endpoints with native thinking.

## Architecture



- **v2.0.0**: Standalone ~200 line Node.js proxy — no external dependencies beyond Node.js built-ins
- Replaces the previous ccr-based architecture which broke after Claude Code v2.1.153 changes
- Handles Claude Code v2.1.156 format compatibility (system role in messages, adaptive thinking)

## Quick Start

[?1049h[?1h=[1;24r[23m[24m[0m[H[J[?25l[24;1H"proxy.js" [New][2;1H[1m[34m~                                                                               [3;1H~                                                                               [4;1H~                                                                               [5;1H~                                                                               [6;1H~                                                                               [7;1H~                                                                               [8;1H~                                                                               [9;1H~                                                                               [10;1H~                                                                               [11;1H~                                                                               [12;1H~                                                                               [13;1H~                                                                               [14;1H~                                                                               [15;1H~                                                                               [16;1H~                                                                               [17;1H~                                                                               [18;1H~                                                                               [19;1H~                                                                               [20;1H~                                                                               [21;1H~                                                                               [22;1H~                                                                               [23;1H~                                                                               [0m[24;63H0,0-1[9CAll[1;1H[34h[?25h[24;1H[?1l>[?1049lVim: Error reading input, exiting...
Vim: Finished.
[24;1H

Add the env vars to  for persistence. Add  crontab for auto-start on server restart.

## Models

| Model | Route | Use | Thinking |
|---|---|---|---|
|  | default, think | Deep reasoning | Converted adaptive→enabled |
|  | background | Fast / background tasks | Stripped (not supported) |
|  | Manual switch | Long docs, plugins | Native |

## Dynamic Model Switching

 works within the same conversation — no need to restart tmux or Claude Code.

## Format Fixes

The proxy handles three Claude Code v2.1.156 incompatibilities with DeepSeek's Anthropic endpoint:

| Fix | Description |
|-----|-------------|
| System role | Moves  from messages array to top-level  field |
| Adaptive thinking | Converts  →  |
| Flash thinking | Strips thinking entirely for flash/haiku models |
| Signature replacement | Replaces DeepSeek-specific signatures with generic ones |
| Thinking block cache | Caches thinking blocks from responses and re-injects them into subsequent requests |

## Thinking Block Cache

DeepSeek's Anthropic endpoint requires thinking blocks to be preserved and passed back in multi-turn conversations. Claude Code v2.1.156 strips these blocks when building subsequent requests.

The proxy maintains a FIFO queue of thinking blocks extracted from streaming responses. When a subsequent request arrives with missing thinking blocks in assistant messages, the proxy re-injects them from the queue.

### Token Cost

The injected thinking blocks are the REAL thinking content from DeepSeek's responses. They would be present in a correctly-functioning Anthropic API flow. The proxy only restores what Claude Code incorrectly strips — there is no additional token cost beyond normal thinking mode usage.

### Reasoning Quality

The cached blocks are DeepSeek's own chain-of-thought from previous turns. Passing them back is REQUIRED by DeepSeek's API for multi-turn reasoning continuity. Without them, the API returns HTTP 400. With them, the model can build on its previous reasoning.

## Files

| File | Purpose |
|---|---|
|  | Standalone proxy — all logic in one file |
|  | Legacy ccr config (no longer used) |
|  | Legacy ccr patches (no longer used) |
|  | Legacy ccr installer (no longer used) |
|  | Env vars template |
|  | This file |

## License

MIT
