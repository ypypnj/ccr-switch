# ccr-switch

Multi-provider model switching for [Claude Code](https://claude.ai/code) via [Claude Code Router (CCR)](https://github.com/musistudio/claude-code-router).

**DeepSeek V4 Pro / V4 Flash + MiniMax M2.7**, all with native thinking support, auto-routing by task type.

## Quick Start

```bash
git clone https://github.com/ypypnj/ccr-switch.git
cd ccr-switch
cp config.example.json config.json
# Edit config.json with your API keys
bash install.sh
source ~/.bashrc
```

## Models

| Model | CCR Shortcut | Use |
|---|---|---|
| DeepSeek V4 Pro | `ds,v4pro` | Deep reasoning (think), default |
| DeepSeek V4 Flash | `ds,v4flash` | Background tasks, fast mode |
| MiniMax M2.7 | `mm,m2.7` | Long context (30k+ chars), docs, tests |

## Auto-Routing

No manual switching needed. CCR detects the scenario and routes automatically:

| Scenario | Trigger | Route |
|---|---|---|
| Deep reasoning | `thinking` enabled | `ds,v4pro` |
| Agent subtasks | `background` / `effort=off` | `ds,v4flash` |
| Long context | >30,000 chars | `mm,m2.7` |
| Documentation | — | `mm,m2.7` |
| Unit tests | — | `mm,m2.7` |
| Default | All else | `ds,v4pro` |

Manual switch anytime: `/model mm,m2.7` or `/model ds,v4pro`.

## Architecture

```
Claude Code ──http──> CCR (127.0.0.1:3456)
                          │
           ┌──────────────┼──────────────┐
           ▼              ▼              ▼
   DeepSeek V4 Pro  DeepSeek V4 Flash  MiniMax M2.7
   (Anthropic)      (Anthropic)        (Anthropic)
   native thinking  fast mode          native thinking
```

Both providers use Anthropic-compatible endpoints. `hN` bypass in CCR skips format conversion — requests flow through natively.

## Requirements

- Node.js 18+
- npm
- [Claude Code Router](https://github.com/musistudio/claude-code-router) v2.0.0+
- DeepSeek and MiniMax API keys

## Files

| File | Purpose |
|---|---|
| `config.json` | Provider & router configuration (gitignored, copy from example) |
| `config.example.json` | Template with placeholders |
| `patch.js` | Patches CCR with model name mapping (55 lines) |
| `install.sh` | One-click installer |
| `bashrc.sh` | Environment variables and CCR auto-start |
| `SKILL.md` | Detailed documentation |

## How It Works

CCR v2.0.0 has a built-in bypass (`hN` function) that detects when the endpoint transformer and provider transformer are the same type. When both use `Anthropic`, it skips all format conversion — requests and responses pass through unmodified.

The only patches needed are model name mappings:
1. DeepSeek transformer: short names → full API IDs
2. Anthropic transformer: same mapping
3. `fD` function: Claude model names → provider model names

All the thinking/reasoning round-trip is handled natively by the Anthropic-compatible endpoints.

## License

MIT
