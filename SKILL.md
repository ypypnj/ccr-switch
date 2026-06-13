---
name: ccr-switch
description: Multi-provider model routing for Claude Code (DeepSeek / MiniMax / 百度千帆 GLM-5.1)
version: 2.0.0
---

# CCR Switch — Multi-Provider Model Routing for Claude Code (v2.0.0 独立路由引擎)

**v2.0.0 重大变更**: ccr-switch 拥有完整独立路由引擎,**不再依赖** [Claude Code Router (CCR)](https://github.com/musistudio/claude-code-router) npm 全局包。`proxy.js` 是 v6 独立路由引擎,直接路由到 DeepSeek / MiniMax / 百度千帆 GLM-5.1,**0 转发层、0 npm 依赖、释放 2.9GB 磁盘**。

> **v2.0.1**: SKILL.md 整体重写,反映 v2.0.0 独立路由引擎的实际行为(命令/路由/故障排除)。

## 核心概念

- **短名格式**: `<provider>,<model>` — 例如 `ds,v4pro` / `mm,m3` / `bd,glm5.1`
- **路由表真源**: `presets.json`(`presets[]` 直连段 + `routes` 角色段)
- **API key 真源**: `~/.claude/dev-flow/credentials.json`(chmod 600)
- **占位符**: `__DS_KEY__` / `__MM_KEY__` / `__BD_KEY__`,install.sh 用 sed 注入真 key
- **进程管理**: systemd(`/etc/systemd/system/ccr-switch.service`)
- **默认端口**: `127.0.0.1:3456`

## 支持的 Provider

| Provider | 短名 | 上游模型 | API Base | Thinking |
|---|---|---|---|---|
| DeepSeek | `ds,v4pro` | `deepseek-v4-pro` | `api.deepseek.com/anthropic` | ✅ Full(round-trip 已在 proxy.js 处理) |
| DeepSeek | `ds,v4flash` | `deepseek-v4-flash` | `api.deepseek.com/anthropic` | N/A(fast mode) |
| MiniMax | `mm,m3` | `MiniMax-M3` | `api.minimaxi.com/anthropic` | ✅ Extended(`budget_tokens=32000`,自动注入) |
| 百度千帆 | `bd,glm5.1` | `glm-5.1` | `qianfan.baidubce.com/anthropic/coding` | ⚠️ 未端到端验证 |

## 安装

```bash
bash /root/ese-project/ccr-switch/install.sh
```

**自动执行**:
1. 备份旧 `proxy.js` → `proxy.js.v<旧版本>.bak.<ts>`
2. 写 v6 proxy.js(占位符版本,无任何真 key)
3. 从 `~/.claude/dev-flow/credentials.json` sed 注入真 key
4. 部署 systemd 单元(`ccr-switch.service`,ExecStart=`node proxy.js 3456`)
5. 启动 + `/health` 健康检查

**幂等**: `bash install.sh --reinstall` 任意时刻重跑,无副作用。

**v2.0.0 清理提示**: 若本机 `~/.claude-code-router/` 目录或 `ccr` 命令仍存在,install.sh 会打印手动清理命令(已不再需要)。

## 命令

| 命令 | 功能 |
|---|---|
| `ccr-switch-on [ds\|mm\|bd\|custom]` | 切到代理模式,写 `ANTHROPIC_BASE_URL=http://127.0.0.1:3456` 到 `.bashrc` managed 块 |
| `ccr-switch-off [ds\|mm\|bd]` | 切到直连模式,清理 `.bashrc` ANTHROPIC_BASE_URL |
| `ccr-switch-status [--json]` | 查看代理状态(PID / systemd / `/health` / `.bashrc` 模式),`--json` 模式供脚本消费 |
| `bash install.sh --reinstall` | 重新部署 proxy.js + 重新注入 key |
| `bash install.sh --ccr-switch-on` | 跳过完整安装,仅启动代理(避免重复 `npm install`) |

所有命令部署在 `/usr/local/bin/`,无需手动配 PATH。

## 模型路由

### 短名解析

请求体 `model` 字段为 `ds,v4pro` 格式时:
- `ds` → 查 `presets.json` 的 `ds` provider
- `v4pro` → 查 `ds.models.v4pro` → `deepseek-v4-pro`(全名,转发给上游)

格式: `ds,v4flash` / `mm,m3` / `bd,glm5.1` 必须是白名单之一,否则走角色路由。

### 角色路由(`routes` 段)

当 `model` 字段**不在**白名单(`ds,v4flash` / `mm,m3` / `bd,glm5.1`)时,proxy.js 按 `routes[role]` 路由:

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

### Thinking 支持

- **`ds,v4pro`**: 透传 `thinking` 块(round-trip 已在 proxy.js 内部处理,无需 ccr-router)
- **`mm,m3`**: 自动注入 `thinking={type:enabled, budget_tokens:32000}`(proxy.js L203-205)
- **`bd,glm5.1`**: 透传 `thinking` 块,**未端到端验证**(v2.0.1 文档缺口)

## 故障排除

### 401 风暴 / Authentication failed

**根因**: 真 key 过期,或 `proxy.js` 仍含占位符(`__DS_KEY__` 等),或 systemd 拉起的是旧版本。

**修复步骤**:
```bash
# 1. 检查 credentials.json 真 key 是否过期
cat ~/.claude/dev-flow/credentials.json   # 仅本机 600 权限可读

# 2. 重新注入(无需重启,install.sh 自动备份+重启)
bash /root/ese-project/ccr-switch/install.sh --reinstall
```

### 占位符守卫 FATAL

proxy.js 启动时检测到 `__DS_KEY__` / `__MM_KEY__` / `__BD_KEY__` 残留 → 立即 `process.exit(1)` 并输出 FATAL 日志。

**修复**: 跑 `bash install.sh --reinstall`(会自动 sed 注入真 key)。

### 429 限流

proxy.js 内置 30s cool-down + 503 + `Retry-After`(v1.3.2 起):
- 同 provider 30s 内全部请求直接 503
- 客户端应尊重 `Retry-After` 头

**频繁触发**说明上游限流,降级到 `ds,v4flash`(fast mode)。

### 健康检查

```bash
curl -sf http://127.0.0.1:3456/health
# 预期: {"status":"ok"}

# 完整状态
ccr-switch-status
# 或 JSON 模式(供脚本消费)
ccr-switch-status --json
```

## 安全

- `proxy.js` 永不含真 key,只有 `__DS_KEY__` / `__MM_KEY__` / `__BD_KEY__` 占位符
- 真 key 唯一来源: `~/.claude/dev-flow/credentials.json`(chmod 600)
- 仓库 `git log -p proxy.js` 0 个 `sk-` 字符串(commit 前会自动扫描)

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
