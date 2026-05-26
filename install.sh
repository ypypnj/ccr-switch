#!/usr/bin/env bash
#
# install.sh — One-click installer for the CCR DeepSeek/MiniMax skill.
#
# What it does:
#   1. Ensures @musistudio/claude-code-router is installed globally.
#   2. Copies config.json to ~/.claude-code-router/.
#   3. Patches CCR's dist/cli.js with model-name mapping, thinking/reasoning
#      cleanup, and entry-point protection.
#   4. Appends CCR env vars and auto-start to ~/.bashrc.
#   5. Restarts CCR so the new config takes effect.
#
# Usage:
#   bash install.sh
#
set -euo pipefail

# ── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ── Self-location ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 1. Install / verify CCR ────────────────────────────────────────────────
info "Checking for @musistudio/claude-code-router..."

if command -v ccr &>/dev/null; then
  ok "@musistudio/claude-code-router is already installed (ccr $(ccr -v 2>/dev/null || echo '?'))."
else
  info "Installing @musistudio/claude-code-router globally (this may take a moment)..."
  npm install -g "@musistudio/claude-code-router"
  ok "Installation complete."
fi

# ── 2. Create config directory and copy config ─────────────────────────────
CCR_DIR="${HOME}/.claude-code-router"
mkdir -p "${CCR_DIR}"

if [[ -f "${SCRIPT_DIR}/config.json" ]]; then
  # User has their own config.json
  if [[ -f "${CCR_DIR}/config.json" ]]; then
    cp "${CCR_DIR}/config.json" "${CCR_DIR}/config.json.bak.$(date +%s)"
    warn "Existing config.json backed up."
  fi
  cp "${SCRIPT_DIR}/config.json" "${CCR_DIR}/config.json"
  ok "Config copied to ${CCR_DIR}/config.json"
elif [[ -f "${SCRIPT_DIR}/config.example.json" ]]; then
  # New user: copy from example template
  if [[ -f "${CCR_DIR}/config.json" ]]; then
    cp "${CCR_DIR}/config.json" "${CCR_DIR}/config.json.bak.$(date +%s)"
    warn "Existing config.json backed up."
  fi
  cp "${SCRIPT_DIR}/config.example.json" "${CCR_DIR}/config.json"
  warn "=============================================="
  warn "  config.example.json copied as config.json"
  warn "  EDIT IT with your API keys before using CCR:"
  warn "  vim ${CCR_DIR}/config.json"
  warn "=============================================="
else
  err "No config.json or config.example.json found in ${SCRIPT_DIR}"
  err "Create ~/.claude-code-router/config.json manually."
  exit 1
fi

# ── 3. Patch CCR transformers ──────────────────────────────────────────────
info "Patching CCR transformers..."
if command -v node &>/dev/null; then
  node "${SCRIPT_DIR}/patch.js"
  ok "Transformer patches applied."
else
  err "Node.js is required but not found in PATH."
  exit 1
fi

# ── 4. Append bashrc snippet ───────────────────────────────────────────────
BASHRC="${HOME}/.bashrc"
MARKER="# === Claude Code Router (CCR) 代理配置 ==="

if grep -qF "${MARKER}" "${BASHRC}" 2>/dev/null; then
  warn "CCR configuration already present in ${BASHRC}, skipping append."
else
  {
    echo ""
    cat "${SCRIPT_DIR}/bashrc.sh"
  } >> "${BASHRC}"
  ok "CCR environment variables and auto-start appended to ${BASHRC}"
  info "Run 'source ${BASHRC}' or open a new shell to apply."
fi

# ── 5. Restart CCR ─────────────────────────────────────────────────────────
info "Restarting Claude Code Router..."

# Stop any existing CCR (more targeted than pkill)
if pgrep -f "node.*claude-code-router" > /dev/null 2>&1; then
  info "Stopping existing CCR instance(s)..."
  ccr stop 2>/dev/null || true
  sleep 2
  # Fallback: kill any remaining node process on port 3456
  fuser -k 3456/tcp 2>/dev/null || true
  sleep 1
fi

# Start fresh
ccr start > /dev/null 2>&1 &
sleep 3

if pgrep -f "node.*claude-code-router" > /dev/null 2>&1; then
  ok "CCR is running (PID $(pgrep -f 'node.*claude-code-router' | head -1))."
else
  warn "CCR may not have started. Check logs with: ccr logs"
fi

# ── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           CCR DeepSeek/MiniMax skill installed!            ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Router endpoint:${NC}  http://127.0.0.1:3456"
echo ""
echo -e "  ${CYAN}Available models:${NC}"
echo -e "    /model ds,v4pro     DeepSeek V4 Pro   (default, think, web)"
echo -e "    /model ds,v4flash   DeepSeek V4 Flash (background tasks)"
echo -e "    /model mm,m2.7      MiniMax M2.7      (long-context docs)"
echo ""
echo -e "  ${CYAN}Quick test:${NC}"
echo -e "    curl http://127.0.0.1:3456/v1/messages \\"
echo -e "      -H \"x-api-key: any-string-is-ok\" \\"
echo -e "      -d '{\"model\":\"v4pro\",\"max_tokens\":100,\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}'"
echo ""
echo -e "  ${YELLOW}NOTE:${NC} Restart your shell or run 'source ~/.bashrc' to pick up"
echo -e "  the ANTHROPIC_BASE_URL and other environment variables."
echo ""
