---
name: ccr-switch
description: Multi-provider model routing for Claude Code (DeepSeek / MiniMax / xapex gpt-5.6-sol)
version: 2.4.3
---

# CCR Switch -- Multi-Provider Model Routing for Claude Code (v2.4.3)

**v2.4.3 修复**: 在流式响应提交 HTTP 200 前解析 `message_start.message.id` 并同步写入 execution receipt；非流式响应同样记录顶层 `id`。缺失、无效或冲突 receipt 时 fail-closed 返回 502，并提供 loopback-only 的 message-ID receipt 查询端点。

**v2.4.2 修复**: 代理通过健康检查和 PID 身份校验后，先将 `<pid> <start-time>` 写入 mode 0600 staging 文件，再原子发布 `proxy.pid`，避免启动成功后因 staging 文件缺失而失败。

**v2.4.1 核心变更**: 完全由 `ModelBindings` 驱动的可核验模型委派。移除旧版 Router 角色路由，所有模型解析通过配置化的精确/通配符绑定完成。模型解析成功后每个响应携带 Dispatch Receipt 头部(unresolvable 模型不携带 receipt)，可独立验证路由决策。`ModelBindings` 可为空(`{}`)以支持纯显式路由。

## 核心概念

- **短名格式**: `<provider>,<model>` -- 例如 `ds,v4pro` / `mm,m3` / `xa,gpt5.6`
- **配置单源真理**: `config.json` 含 `Providers[]`(端点/key/models) 和 `ModelBindings`(路由规则)
- **可核验委派**: 每次请求响应带有 `X-CCR-Dispatch-Id`、`X-CCR-Resolved-Provider`、`X-CCR-Resolved-Model`、`X-CCR-Config-Fingerprint` 头部
- **无静默 fallback**: 未配置的模型返回 400 `unknown_model`，不降级到 default provider
- **进程管理**: nohup 或 systemd 用户单元
- **默认端口**: `127.0.0.1:3456`

## 支持的 Provider

| Provider | 短名 | 上游模型 | Thinking |
|---|---|---|---|
| DeepSeek | `ds,v4pro` | `deepseek-v4-pro` | thinking 缓存 round-trip |
| DeepSeek | `ds,v4flash` | `deepseek-v4-flash` | 无(快速模式) |
| MiniMax | `mm,m3` | `MiniMax-M3` | extended thinking 自动注入 |
| xapex | `xa,gpt5.6` | `gpt-5.6-sol` | 透传(非 thinking) |

## 安装

```bash
bash /root/ese-project/ccr-switch/install.sh
```

**自动执行**: 提示输入 xa key → 原子生成 `~/.config/ccr-switch/config.json`(0600) 和 `credentials.json`(0600) → 部署 proxy.js 和控制脚本到 `~/.local/share/ccr-switch/` → 启动代理。

**幂等**: `bash install.sh --reinstall` 任意时刻重跑，无副作用。

## 命令

| 命令 | 功能 |
|---|---|
| `ccr-switch-on` | 启动代理(nohup 或 systemd 用户单元) |
| `ccr-switch-off` | 停止代理(PID 身份校验后 kill) |
| `ccr-switch-status` | 通过 `/health` 检查可用性 |
| `bash install.sh --reinstall` | 重新生成 config.json + 重启代理 |
| `bash install.sh --ccr-switch-on` | 跳过安装，仅启动代理 |

## 模型路由 -- ModelBindings 驱动

### 解析流程

```
请求 model 字段
  → ModelBindings 精确匹配
  → ModelBindings 通配符前缀匹配(最长前缀优先)
    → 命中: 使用绑定的目标 (provider,model)
    → 未命中: 解析为 "provider,model" 格式直接查找
      → 有效: 转发
    → 未命中: 尝试全局唯一裸别名
      → 仅一个 provider 有该别名: 转发
      → 否则: 400 unknown_model
```

`ModelBindings` 可为空(`{}`)，此时只接受显式 `provider,alias` 或全局唯一裸别名。

### ModelBindings 配置

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

- **精确键优先**: 完整模型名精确匹配
- **通配符后缀** (`*`): 匹配所有以该前缀开头的模型。多个通配符匹配时，最长前缀获胜
- **目标格式**: `providerShortName,modelAlias`，必须在 Providers 中存在(启动期校验)
- **空 ModelBindings**: `"ModelBindings": {}` 是合法配置，此时所有请求必须使用显式 `provider,alias` 或全局唯一裸别名
- **仅改配置**: 切换映射目标只需编辑 config.json 并重启代理，无需改代码

### Dispatch Receipt

模型解析成功后，每个响应携带以下头部(400 `unknown_model` 等未解析错误的响应不携带 receipt):

```
X-CCR-Dispatch-Id: <24 hex chars>
X-CCR-Requested-Model: <wire model>
X-CCR-Resolved-Provider: <provider short name>
X-CCR-Resolved-Model: <upstream model name>
X-CCR-Config-Fingerprint: <SHA-256 of provider+binding config>
```

### Execution Receipt 查询

成功响应的 message ID 会关联到进程内 execution receipt。仅 loopback 客户端可查询：

```text
GET /v1/receipts/by-message-id/<message-id>
```

返回 200 表示找到；404 表示未记录；409 表示同一 message ID 存在冲突。流式和非流式上游若返回 HTTP 200 却无法形成有效 receipt，代理会 fail-closed 返回 502 `missing_message_receipt`。

## config.json 结构

```jsonc
{
  "Providers": [
    {
      "name": "ds",
      "api_base_url": "https://api.deepseek.com/anthropic/v1/messages",
      "api_key": "sk-...",
      "models": { "v4pro": "deepseek-v4-pro", "v4flash": "deepseek-v4-flash" }
    }
  ],
  "ModelBindings": {
    "claude-haiku-*": "ds,v4flash"
  }
}
```

**新增 provider 步骤**:
1. 在 `Providers[]` 加一段(name/api_base_url/api_key/models)
2. 在 `ModelBindings` 加需要的映射(可选)
3. 重启代理

## 故障排除

### 未知模型 400

**症状**: `curl -X POST /v1/messages -d '{"model":"some-unknown-model",...}'` 返回 `{"error":{"type":"unknown_model",...}}`

**原因**: 模型名不在 ModelBindings 中，也不是有效的 `provider,alias` 格式，也不是全局唯一裸别名。

**修复**: 在 `config.json` 的 `ModelBindings` 加映射，或确保请求使用有效的 `provider,alias` 格式或全局唯一裸别名。

### 占位符 FATAL 守卫

proxy.js 启动时检测 `config.json` 的 `Providers[].api_key` 含 `__` 或 `YOUR_` 字样 → 立即 `process.exit(1)` 并输出 FATAL 日志。

**修复**: 跑 `bash install.sh --reinstall`(会自动用真 key 替换占位符)。

### 429 限流与 circuit-open

proxy.js 内置 30s provider 级 cool-down:
- 上游 429/503/529 → 标记该 provider 冷却 → 同 provider 30s 内全部请求直接 503 `provider_circuit_open`
- 其他 provider 不受影响(独立冷却)
- 响应含 `Retry-After` 头部

### GLM-5.2 auto mode 兜底(v2.2.0 内置)

thinking 模型在 max_tokens 受限时可能输出空 text 块，触发 Claude Code auto mode 误判。proxy.js 自动追加 "OK" 占位 text 块(streaming: message_stop 前注入; non-streaming: content 末尾追加)。

### models 数组格式 FATAL

`config.json` 中 `Providers[].models` 必须为对象映射格式 `{"短名":"上游模型名"}`，数组格式(v2.0 遗留)启动时 `exit(1)`。

### 健康检查

```bash
curl -sf http://127.0.0.1:3456/health        # {"status":"ok"}
curl -sf http://127.0.0.1:3456/v1/models     # 列所有可用模型
ccr-switch-status
```

## 安全

- `proxy.js` 0 个 API key 字符串(commit 前自动扫描)
- `config.json` 含真 key，权限 600，git ignore
- 安装器使用原子 mv、事务回滚、inode 身份验证防篡改
- 仓库 `git log -p proxy.js` 历史记录里 0 个真 key

## 卸载

```bash
ccr-switch-off
rm -rf ~/.local/share/ccr-switch ~/.config/ccr-switch
# systemd 用户单元(如使用): systemctl --user disable ccr-switch.service
```

## 版本历史

参见 [`CHANGELOG.html`](./CHANGELOG.html)
