# ccr-switch v1.0.0

Multi-provider model switching for [Claude Code](https://claude.ai/code) via [Claude Code Router (CCR)](https://github.com/musistudio/claude-code-router) v2.0.0.

**DeepSeek V4 Pro / V4 Flash + MiniMax M2.7**, all via Anthropic-compatible endpoints with native thinking.

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

| Model | Route | Billing | Use |
|---|---|---|---|
| DeepSeek V4 Pro | `ds,v4pro` | DS API | Deep reasoning, default |
| DeepSeek V4 Flash | `ds,v4flash` | DS API | Background tasks, fast |
| MiniMax M2.7 | `mm,m2.7` | MiniMax API | Long context, docs, tests |

## Auto-Routing

No manual switching. CCR detects scenario and routes automatically.

| Trigger | Route |
|---|---|
| `thinking` enabled | `ds,v4pro` |
| Background task ("haiku" model) | `ds,v4flash` |
| Prompt > 30,000 chars | `mm,m2.7` |
| All else | `ds,v4pro` |

Manual switch anytime: `/model mm,m2.7` or `/model ds,v4pro`.

## Architecture

```
Claude Code --http--> CCR (127.0.0.1:3456)
                          |
           ---------------+--------------
           |              |              |
   DeepSeek V4 Pro  DeepSeek V4 Flash  MiniMax M2.7
   Anthropic API    Anthropic API      Anthropic API
   native thinking  fast mode          native thinking
```

Both providers use Anthropic-compatible endpoints. CCR's built-in bypass skips format conversion -- requests flow natively.

## Important

Do NOT set `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, or `ANTHROPIC_MODEL` env vars. They override CCR's auto-routing. Let Claude Code use its default model names -- CCR's Router middleware handles the mapping.

## Requirements

- Node.js 18+ / npm
- CCR v2.0.0+
- DeepSeek and MiniMax API keys

## Files

| File | Purpose |
|---|---|
| `config.example.json` | Template (copy to config.json, add keys) |
| `patch.js` | Model name mapping (55 lines) |
| `install.sh` | One-click installer |
| `bashrc.sh` | Env vars + CCR auto-start |
| `SKILL.md` | Detailed docs, troubleshooting |

## License

MIT
