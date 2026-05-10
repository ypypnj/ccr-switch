# CCR Switch — Multi-Provider Model Switching for Claude Code

Configures [Claude Code Router (CCR)](https://github.com/musistudio/claude-code-router) v2.0.0 to route Claude Code requests through **DeepSeek** (V4 Pro / V4 Flash) and **MiniMax** (M2.7), with full **deep reasoning (thinking) support** on DeepSeek V4 Pro.

---

## Architecture

```
Claude Code  ──http──>  CCR (127.0.0.1:3456)
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
      DeepSeek V4 Pro  DeepSeek V4 Flash  MiniMax M2.7
      (ds,v4pro)       (ds,v4flash)       (mm,m2.7)
      OpenAI compat    OpenAI compat      OpenAI compat
      + thinking ✅     fast mode          + native thinking
```

---

## Models

| Model | Route | Use | Thinking |
|---|---|---|---|
| `/model ds,v4pro` | default, think, webSearch | General + deep reasoning | ✅ Full |
| `/model ds,v4flash` | background | Fast / background tasks | N/A |
| `/model mm,m2.7` | longContext (60k+ chars) | Long docs, plugins | ✅ Native `<think>` |

---

## Patches Applied by patch.js

patch.js modifies CCR's `dist/cli.js` to fix the thinking/reasoning round-trip that is broken in vanilla CCR v2.0.0.

| Layer | Location | Fix |
|---|---|---|
| 1. Model mapping | DeepSeek + Anthropic transformers | Short names (`v4pro`, `m2.7`) → full API identifiers |
| 2. Anthropic source | `transformRequestOut` | Keep `thinking→reasoning` conversion; handle empty-signature thinking blocks from conversation history |
| 3. DeepSeek transformer | `transformRequestIn` | Convert `m.thinking` → `m.reasoning_content` for OpenAI format; strip Anthropic `thinking` field; filter thinking blocks from system/messages |
| 4. fD function | Pre + post auth | Model name mapping with `provider,model` prefix handling |
| 5. forcereasoning | Disabled | Wrong XML-embedding approach replaced by proper field-level conversion |
| 6. Response cleanup | DeepSeek `transformResponseOut` | Strip `reasoning_content` from JSON responses (streaming handled via normal flow) |

### Thinking Round-Trip

```
Request: Claude Code sends thinking={enabled}
  → Anthropic: thinking → r.reasoning (top-level) + s.thinking (message-level)
  → DeepSeek: m.thinking → m.reasoning_content (OpenAI format)
  → DeepSeek API: receives reasoning_content, enters thinking mode

Response: DeepSeek returns reasoning_content in stream
  → DeepSeek streaming: reasoning_content flows through
  → Anthropic convertOpenAIStreamToAnthropic: reasoning_content → thinking blocks
  → Claude Code: receives thinking blocks, displays + stores in history

Next request:
  → Claude Code sends thinking blocks in history
  → Anthropic: extracts thinking (with or without signature)
  → DeepSeek: converts back to reasoning_content
  → DeepSeek API: receives reasoning_content ✓
```

---

## Installation

```bash
bash /path/to/ccr-switch/install.sh
```

---

## File Reference

| File | Purpose |
|---|---|
| `config.json` | Provider & router config (MiniMax uses `/v1/chat/completions` + Bearer) |
| `patch.js` | Patches CCR's `dist/cli.js` with all fixes |
| `bashrc.sh` | Env vars + CCR auto-start |
| `install.sh` | One-click installer |
| `SKILL.md` | Documentation |

---

## Troubleshooting

### "reasoning_content must be passed back"

This is the DeepSeek thinking round-trip error. Re-run `node patch.js` and `ccr restart`. If it persists, check that the running CCR process loaded the latest cli.js.

### Model name errors

Ensure model mapping is applied: `grep "m.reasoning_content=m.thinking.content" /usr/local/lib/node_modules/@musistudio/claude-code-router/dist/cli.js`

### MiniMax not responding

Verify config has `"api_base_url": "https://api.minimaxi.com/v1/chat/completions"` and `"UseBearer": true`.

### Restore original CCR

```bash
npm install -g @musistudio/claude-code-router@2.0.0
```
