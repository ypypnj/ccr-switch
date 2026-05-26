# === Claude Code Router (CCR) 代理配置 ===
export ANTHROPIC_BASE_URL="http://127.0.0.1:3456"
export ANTHROPIC_AUTH_TOKEN="any-string-is-ok"
export ANTHROPIC_TIMEOUT=600

# CCR 自动启动
if ! pgrep -f "claude-code-router" > /dev/null 2>&1; then
  ccr start > /dev/null 2>&1 &
fi
