# ccr-switch v1.3.1

Multi-provider model switching for Claude Code. DeepSeek V4 Pro / V4 Flash + MiniMax M3 + Baidu Qianfan GLM-5.1.

## Architecture

```
Claude Code  --http-->  proxy.js (127.0.0.1:3456)
                             |
              +--------------+--------------+--------------+
              |              |              |              |
      DeepSeek V4 Pro  DeepSeek V4 Flash  MiniMax M3  Baidu GLM-5.1
      (ds,v4pro)       (ds,v4flash)       (mm,m3)      (bd,glm5.1)
```

Standalone ~270 line Node.js proxy. Zero external dependencies.

## Quick Start

```bash
git clone https://github.com/ypypnj/ccr-switch.git
cd ccr-switch
bash install.sh   # 自动配置 credentials / 部署 ccr-switch-off/on / 启动代理
```

## Models

| Command | Provider | Model | Thinking |
|---------|----------|-------|----------|
| `/model ds,v4pro` | DeepSeek | V4 Pro | adaptive |
| `/model ds,v4flash` | DeepSeek | V4 Flash | — |
| `/model mm,m3` | MiniMax | M3 | enabled (32k budget) |
| `/model bd,glm5.1` | Baidu Qianfan | GLM-5.1 | enabled (8k budget) |

Chinese comma ( ，) auto-normalized to ASCII comma.

## 代理 ⇄ 直连 切换

| 命令 | 效果 |
|------|------|
| `ccr-switch-on` | 启动 proxy.js，改 .bashrc 切回 ccr 端点（默认） |
| `ccr-switch-off ds` | 停 proxy.js，改 .bashrc 直连 DeepSeek V4 Pro |
| `ccr-switch-off mm` | 停 proxy.js，改 .bashrc 直连 MiniMax M3 |
| `ccr-switch-off bd` | 停 proxy.js，改 .bashrc 直连 Baidu Qianfan GLM-5.1 |
| `ccr-switch-off custom` | 停 proxy.js，交互输入 base_url / api_key / model 直连任意上游 |
| `ccr-switch-off` | 显示菜单交互选择 |

切换后**必须关闭 Claude Code session → `source ~/.bashrc` → 重启 claude** 才能生效（脚本会提示当前运行的 claude PID）。

## 凭据管理

- 真 key 存储于 `~/.claude/dev-flow/credentials.json`（chmod 600，**不入 git**）
- 文件结构：`{ "ds_key": "...", "mm_key": "...", "bd_key": "..." }`
- 仓库内只有占位符 `__DS_KEY__` / `__MM_KEY__` / `__BD_KEY__`
- `install.sh` 首次运行会交互提示缺失的 key；之后可手动编辑该文件
- 重新部署：`bash install.sh`（会保留已有 key，不会重复询问）

## What the Proxy Does

| Fix | Why |
|-----|-----|
| System role → top-level | Claude Code v2.1.156 put system in messages (no-op safety net) |
| Chinese comma fix | `/model` input may use Chinese comma |
| /v1/models endpoint | Required for `/model` command validation |
| M3 thinking auto-enable | MiniMax M3 默认启用 extended thinking（budget_tokens=32000） |
| GLM-5.1 thinking auto-enable | 保守启用（budget_tokens=8000） |
| Provider routing | `ds,v4pro` / `ds,v4flash` / `mm,m3` / `bd,glm5.1` → 对应上游 |

## What the Proxy Does NOT Do

- No thinking block caching or injection (streaming cache disabled)
- No default effort override
- No signature rewriting

## Files

| File | Purpose | Git |
|------|---------|-----|
| proxy.js | Standalone proxy（占位符 key） | ✅ |
| presets.json | 3 直连预设 + ccr 段（占位符 key） | ❌ git ignored |
| presets.example.json | presets.json 模板 | ✅ |
| install.sh | 9 步安装/部署/凭据/启动 | ✅ |
| scripts/ccr-switch-off | 切换到直连 | ✅ |
| scripts/ccr-switch-on | 切回代理 | ✅ |
| config.json / config.example.json | 旧 ccr 兼容（占位符 key） | ❌ / ✅ |
| patch.js | 旧 ccr 兼容（已不跑） | ✅ |

## 版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-06-09 | v1.3.2 | 修复 429 风暴导致进程退出根因（4 层 socket 错误监听 + 进程异常兜底 + coolDown）+ log rotate 5MB |
| 2026-06-09 | v1.3.0 | Baidu Qianfan GLM-5.1 + 直连/代理切换脚本（ccr-switch-off/on）+ 安全改造（真 key 移出仓库） |
| 2026-06-07 | v1.2.0 | MiniMax M2.7 → M3 替换，M3 默认启用 extended thinking |
| 2026-05-30 | v1.1.0 | 修复 content-length 重新计算，Chinese comma 兼容 |
| 2026-05-26 | v1.0.0 | 初始版本，DeepSeek V4 Pro/Flash + MiniMax M2.7 |
