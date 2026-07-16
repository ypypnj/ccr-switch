---
name: ccr-switch
description: Multi-provider model routing for Claude Code (DeepSeek / MiniMax / 百度千帆 GLM-5.2 / xapex gpt-5.6-sol)
version: 2.4.0
---

# CCR Switch — Multi-Provider Model Routing for Claude Code (v2.4.0)

**v2.4.0 增量变更**: 两项独立变更合并发布。

1. **新增 `xa,gpt5.6` provider**:接入 xapex.cn 的 `gpt-5.6-sol` 上游模型(Anthropic Messages API 兼容)。只需改 `config.json`(`Providers[]` 加 `xa` 段),`proxy.js` 无任何改动 —— 这是 v2.1.0 "改 `config.json` 即可增 provider" 架构的再次验证。短名 `xa,gpt5.6` + 别名 `xa,gpt-5.6-sol`,非 thinking 模型,无注入/兜底。
2. **流式无声断连防御**(v2.3.1 内置):GLM 在高 thinking 请求时偶发 socket 关闭但不触发 `end`/`error`(负载均衡切换 / SSL 重协商失败 / RST),旧版 res 悬挂 → 客户端 `Unexpected EOF`。v2.3.1 监听 `upRes.on('close')`,断连时补 `message_delta(stop_reason=max_tokens)` + `message_stop` 截断结尾,客户端收到"完整但被截断"响应而非 EOF 硬错误。

**v2.3.0 增量变更**: 修复 Claude Code sub-agent 调用触发 `JSON Parse error: Unexpected EOF` 的根因。Claude Code 的 sub-agent / auto mode classifier 内部用 `claude-opus-4-8` / `claude-sonnet-4-6` / `claude-haiku-4-5` 等 Claude 官方 model 名发请求,这些别名之前在 `config.json` 的 `ds.models` 里映射到 `deepseek-v4-pro`。当 ds key 失效(401)时,上游返回裸 JSON 错误体,proxy 流式路径把它当 SSE 转发 → 客户端 SSE 解析器等不到 `\n\n` 终止符 → `Unexpected EOF`。v2.3.0 两层修复:

1. **claude-* 别名重定向到 GLM**:把 `claude-opus-4-8` / `claude-opus-4-7` / `claude-sonnet-5` / `claude-sonnet-4-6` / `claude-haiku-4-5` 从 `ds.models` 移到 `bd.models`,值改为 `glm-5.2`。sub-agent 不再依赖 ds,直接走 GLM。
2. **流式非 200 防御**:proxy.js 流式路径收到上游非 200(非 429)状态码时,丢弃上游非 SSE 错误体,返回自洽的非流式 JSON 错误(`upstream_error` + 真实状态码),杜绝畸形 SSE。

**v2.2.0 增量变更**: 在 v2.1.0 基础上,给 GLM-5.2 等 thinking 模型加 **auto mode 兜底**。GLM-5.2 在 `max_tokens` 受限时倾向于把所有 token 分配给思考,文本块为空,触发 Claude Code `auto mode` 误判 `bd,glm5.2 is temporarily unavailable`。v2.2.0 在响应末尾自动追加 `"OK"` 占位 text 块(streaming 路径在 `message_stop` 前注入),让 auto mode 看到非空响应。

**v2.1.0 重大变更**: `proxy.js` 不再硬编码任何 provider 配置。启动时从同目录的 **`config.json`** 读 PROVIDERS(`url` / `key` / `models` 映射),`config.json` 是单源真理。新增百度千帆 `bd,glm5.2`(tokenplan/personal 端点),`api_key` 从 `~/.claude/dev-flow/credentials.json` 注入。

> **v2.1.0 重构动机**: v2.0.0 时 `proxy.js` 第 64-68 行 `PROVIDERS` 硬编码,新增 model 必须改源码。GLM-5.1→GLM-5.2 升级时被遗忘,导致 `bd,glm5.2` 请求全部 fallback 到 deepseek。v2.1.0 删掉所有硬编码,改读 `config.json`,新增 model 只需改配置文件。

## 核心概念

- **短名格式**: `<provider>,<model>` — 例如 `ds,v4pro` / `mm,m3` / `bd,glm5.2`
- **provider 配置真源**: `config.json`(`Providers[]` 段含 `api_base_url` / `api_key` / `models`)
- **路由表真源**: `config.json`(`Router` 段,`presets.json` 的 `routes` 也保留以兼容直连模式)
- **直连预设真源**: `presets.json`(`presets[]` 段)
- **API key 真源**: `~/.claude/dev-flow/credentials.json`(chmod 600)
- **进程管理**: systemd(`/etc/systemd/system/ccr-switch.service`)
- **默认端口**: `127.0.0.1:3456`

## 支持的 Provider

| Provider | 短名 | 上游模型 | API Base | Thinking |
|---|---|---|---|---|
| DeepSeek | `ds,v4pro` | `deepseek-v4-pro` | `api.deepseek.com/anthropic` | ✅ Full(round-trip 已在 proxy.js 处理) |
| DeepSeek | `ds,v4flash` | `deepseek-v4-flash` | `api.deepseek.com/anthropic` | N/A(fast mode) |
| MiniMax | `mm,m3` | `MiniMax-M3` | `api.minimaxi.com/anthropic` | ✅ Extended(`budget_tokens=32000`,自动注入) |
| 百度千帆 | `bd,glm5.2` | `glm-5.2` | `qianfan.baidubce.com/anthropic/tokenplan/personal` | ✅ Extended(原生) |
| xapex | `xa,gpt5.6` | `gpt-5.6-sol` | `cn.xapex.cc/v1/messages` | N/A |

## 安装

```bash
bash /root/ese-project/ccr-switch/install.sh
```

**自动执行**:
1. 从 `config.example.json` 复制 + 用 `~/.claude/dev-flow/credentials.json` 真 key sed 注入 → `config.json`(权限 600)
2. 从 `presets.example.json` 复制为 `presets.json`(权限 600)
3. 部署 systemd 单元(`ccr-switch.service`,ExecStart=`node proxy.js 3456`)
4. 启动 + `/health` 健康检查

**幂等**: `bash install.sh --reinstall` 任意时刻重跑,无副作用。

**v2.0.0 清理提示**: 若本机 `~/.claude-code-router/` 目录或 `ccr` 命令仍存在,install.sh 会打印手动清理命令(已不再需要)。

## 命令

| 命令 | 功能 |
|---|---|
| `ccr-switch-on [ds\|mm\|bd\|custom]` | 切到代理模式,写 `ANTHROPIC_BASE_URL=http://127.0.0.1:3456` 到 `.bashrc` managed 块 |
| `ccr-switch-off [ds\|mm\|bd]` | 切到直连模式,清理 `.bashrc` ANTHROPIC_BASE_URL |
| `ccr-switch-status [--json]` | 查看代理状态(PID / systemd / `/health` / `.bashrc` 模式) |
| `bash install.sh --reinstall` | 重新生成 `config.json` + 注入真 key + 重启代理 |
| `bash install.sh --ccr-switch-on` | 跳过完整安装,仅启动代理(避免重复生成 config) |

所有命令部署在 `/usr/local/bin/`,无需手动配 PATH。

## 模型路由

### 短名解析

请求体 `model` 字段为 `ds,v4pro` 格式时:
- `ds` → 查 `config.json` 的 `Providers[ds]`
- `v4pro` → 查 `ds.models.v4pro`(对象 key) → `deepseek-v4-pro`(对象 value,转发给上游)

**`models` 段必须为对象格式** `{ "短名": "上游模型名" }`,数组格式已废弃,v2.1.0 启动时会检测并 `exit(1)` 拒绝运行。

格式 `ds,v4pro` / `ds,v4flash` / `mm,m3` / `bd,glm5.2` 等必须在白名单,否则走角色路由。

### 角色路由(`Router` 段)

当 `model` 字段**不在**白名单时,proxy.js 按 `config.json` 的 `Router[role]` 路由:

| Role | 默认模型 | 用途 |
|---|---|---|
| `default` | `ds,v4pro` | 兜底 |
| `background` | `ds,v4flash` | 后台/快速任务 |
| `think` | `ds,v4pro` | 深度推理 |
| `longContext` | `ds,v4pro` | 长上下文(>200k chars) |
| `longContextThreshold` | `200000` | 长上下文阈值 |
| `webSearch` | `ds,v4pro` | 联网搜索 |
| `doc` | `mm,m3` | 文档生成 |
| `test` | `mm,m3` | 测试生成/补全 |
| `backgroundAlt` | `ds,v4flash` | 备用快速任务 |
| `glm` | `bd,glm5.2` | GLM 专用 role(可选) |

### Thinking 支持

- **`ds,v4pro`**: 透传 `thinking` 块(round-trip 已在 proxy.js 内部处理,无需 ccr-router)
- **`mm,m3`**: 自动注入 `thinking={type:enabled, budget_tokens:32000}`(proxy.js L203-205)
- **`bd,glm5.2`**: 透传 `thinking` 块,GLM-5.2 原生支持(已在 v2.1.0 端到端验证)
- **`xa,gpt5.6`**: 非 thinking 模型;proxy 透传 `thinking` 块(若上游不支持则忽略)

## config.json 结构

```jsonc
{
  "LOG": true,
  "API_TIMEOUT_MS": 600000,
  "Providers": [
    {
      "name": "bd",                                    // 短名前缀
      "api_base_url": "https://.../v1/messages",       // 必须包含 /v1/messages
      "api_key": "bce-v3/...",                         // 真 key 或占位符 install.sh 自动注入
      "models": {                                      // 对象:短名 → 上游模型名
        "glm5.2": "glm-5.2",
        "glm-5.2": "glm-5.2"
      },
      "transformer": { "use": ["Anthropic"] }
    }
    // ... 其它 provider
  ],
  "Router": {
    "default": "ds,v4pro",
    "glm": "bd,glm5.2"
    // ... 其它 role
  }
}
```

**新增 provider 步骤**:
1. 在 `Providers[]` 加一段(`name` / `api_base_url` / `api_key` / `models` / `transformer`)
2. 在 `Router` 加你想挂的 role(可选)
3. `pkill -f "proxy.js 3456" && node proxy.js 3456 &` 重启代理

> **v2.4.0 新增 provider 验证**: `xa,gpt5.6` 是首个按上述步骤纯改 config 添加的 provider —— proxy.js 零改动即生效,验证了 v2.1.0 "单源真理" 架构的扩展性。

## 故障排除

### 401 风暴 / Authentication failed

**根因**: `config.json` 的 `api_key` 过期,或仍含占位符。

**修复**:
```bash
# 1. 检查真 key 是否过期
cat ~/.claude/dev-flow/credentials.json

# 2. 重新生成 config.json 并注入真 key
bash /root/ese-project/ccr-switch/install.sh --reinstall
```

### placeholder FATAL 守卫(v2.1.0 重写)

proxy.js 启动时检测 `config.json` 的 `Providers[].api_key` 含 `__` 或 `YOUR_` 字样 → 立即 `process.exit(1)` 并输出 FATAL 日志。

**修复**: 跑 `bash install.sh --reinstall`(会自动用真 key 注入占位符)。

### JSON Parse error: Unexpected EOF(v2.3.0 修复)

**症状**: Claude Code 报 `API Error: JSON Parse error: Unexpected EOF`,且错误归到当前 model(如 `bd,glm5.2`)名下。

**根因**: 不是当前 model 的问题,是 **sub-agent / auto mode classifier 用 `claude-opus-4-8` 等 Claude 官 model 名发流式请求**,这些别名在 `config.json` 里映射到的 provider(默认 ds)返回 401/5xx 时,上游响应是裸 JSON 错误体(非 SSE)。proxy 流式路径把它当 SSE `res.write` 半行转发,客户端 SSE 解析器等不到 `\n\n` 终止符 → EOF。Claude Code 把错误归到 user-facing model 名下显示,造成误判。

**诊断**: 看 `/tmp/proxy-debug.log`,找 `SEND model=deepseek-v4-pro ... STREAM ERROR 401` 配对 `REQ model=claude-opus-4-8`。如果有,就是 claude-* 别名打到了失效的 ds。

**修复**(v2.3.0 已内置):
1. claude-* 别名已重定向到 `bd.models` → `glm-5.2`,sub-agent 不再走 ds
2. 流式非 200 已防御,返回自洽 JSON,不再产生 EOF

**手动确认**:
```bash
curl -s -X POST http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-8","max_tokens":50,"messages":[{"role":"user","content":"say OK"}]}'
# 预期: 200,content 含 thinking + "OK",日志 SEND model=glm-5.2
```

### GLM-5.2 auto mode "temporarily unavailable"(v2.2.0 修复)

**症状**: `/model bd,glm5.2` 后,Claude Code 报:
```
bd,glm5.2 is temporarily unavailable, so auto mode cannot determine the safety of Agent right now.
```

**根因**: GLM-5.2 是 thinking 模型,在 `max_tokens` 受限时倾向把所有 token 分配给思考,输出**空 text 块**。Claude Code `auto mode` 的 safety probe 要求非空 text 回复,看到空就误判"模型不可用"。

**修复**: v2.2.0 在 proxy.js 响应处理阶段自动追加 `"OK"` 占位 text 块:
- non-streaming:在 `rj.content` 末尾追加 `{type: "text", text: "OK"}`
- streaming:在 `event: message_stop` 之前注入 3 个 SSE 事件(content_block_start / content_block_delta "OK" / content_block_stop,index=99)
- 触发条件:`seenThinking && !hasNonEmptyText`(有 thinking + 无非空 text)
- 不影响真实对话:模型正常输出非空 text 时,兜底逻辑不触发

proxy log 会记录 `AUTO MODE FALLBACK: 注入占位 text 块` 或 `AUTO MODE FALLBACK (stream): 注入占位 text_delta` 用于诊断。

### models 数组格式 FATAL(v2.1.0 新增)

`config.json` 中 `Providers[].models` 若为数组(老 v2.0 格式),启动时立即 `exit(1)`:
```
FATAL: Provider bd 的 models 字段为数组格式(v2.0),请升级为对象映射格式。
  参考 config.example.json 中的新格式: {"短名":"上游模型名", ...}
```

**修复**: 编辑 `config.json`,把 `models` 数组改成 `{ "短名": "上游模型名", ... }` 对象。

### 429 限流

proxy.js 内置 30s cool-down + 503 + `Retry-After`(v1.3.2 起):
- 同 provider 30s 内全部请求直接 503
- 客户端应尊重 `Retry-After` 头

**频繁触发**说明上游限流,降级到 `ds,v4flash`(fast mode)。

### 健康检查

```bash
curl -sf http://127.0.0.1:3456/health
# 预期: {"status":"ok"}

# 列所有可用 model
curl -sf http://127.0.0.1:3456/v1/models

# 完整状态
ccr-switch-status
```

## 安全

- `proxy.js` 0 个 `sk-` 字符串(commit 前自动扫描)
- `config.json` 含真 key,权限 600,git ignore
- 真 key 唯一来源: `~/.claude/dev-flow/credentials.json`(chmod 600)
- 仓库 `git log -p proxy.js` 历史记录里 0 个真 key 出现

## 卸载

```bash
# 1. 停服务
ccr-switch-off                          # 切到直连 + 停代理
sudo systemctl stop ccr-switch
sudo systemctl disable ccr-switch
sudo rm /etc/systemd/system/ccr-switch.service
sudo systemctl daemon-reload

# 2. 删命令
sudo rm /usr/local/bin/ccr-switch-{on,off,status}

# 3. 删源码
rm -rf /root/ese-project/ccr-switch
```

## 版本历史

参见 [`CHANGELOG.html`](./CHANGELOG.html)
