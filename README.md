# ccr-switch v1.1.0

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

| Model | Route | Use |
|---|---|---|
| DeepSeek V4 Pro | `sonnet` / `opus` | Deep reasoning, default |
| DeepSeek V4 Flash | `haiku` / `ds,v4flash` | Subagents, background tasks |
| MiniMax M2.7 | `/model mm,m2.7` | Manual switch |

## Auto-Routing

No manual switching. CCR Router detects scenario:

| Trigger | Route |
|---|---|
| `thinking` enabled | `ds,v4pro` |
| Model name contains `haiku` or `flash` | `ds,v4flash` |
| Prompt > 200,000 chars | `ds,v4pro` |

Manual switch: `/model mm,m2.7` or `/model ds,v4pro` or `/model ds,v4flash`.

## Subagents

For GSD plugins, set:
```bash
export CLAUDE_CODE_SUBAGENT_MODEL=haiku
export ANTHROPIC_DEFAULT_HAIKU_MODEL=haiku
```
CCR detects `haiku` in model name → routes to v4flash.

## Architecture

Both providers use Anthropic-compatible endpoints. CCR built-in bypass skips format conversion.

## Files

| File | Purpose |
|---|---|
| `config.example.json` | Template (copy to config.json) |
| `patch.js` | Model name mapping + Router fix |
| `install.sh` | One-click installer |
| `bashrc.sh` | Env vars + CCR auto-start |
| `SKILL.md` | Detailed docs |

## License

MIT
