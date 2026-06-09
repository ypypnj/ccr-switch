#!/usr/bin/env bash
#
# install.sh — ccr-switch v1.3.0 一键安装脚本
#
# 功能:
#   1. 安装/验证 @musistudio/claude-code-router
#   2. 部署 config.json → ~/.claude-code-router/
#   3. 运行 patch.js 修补 transformer (兼容旧架构,proxy.js 不依赖)
#   4. 管理 ~/.claude/dev-flow/credentials.json (chmod 600,真 key 存储)
#   5. 部署 presets.json (从 presets.example.json 复制) + proxy.js 占位符替换
#   6. 部署 ccr-switch-off / ccr-switch-on 到 /usr/local/bin
#   7. 追加 .bashrc 段 (与 ccr-switch-on 共享 marker 块)
#   8. 启动 ccr-switch 代理
#
# 用法:
#   bash install.sh
#
# v1.3.0 安全改造: 真 key 全部从 ~/.claude/dev-flow/credentials.json 读取,
#                  不再硬编码于 proxy.js / presets.json 入库。
#                  install.sh 首次运行会检测缺失的 key,提示用户输入。
#
# 用法:
#   bash install.sh                    # 完整安装(默认)
#   bash install.sh --reinstall        # 强制重新替换占位符并启动代理
#   bash install.sh --ccr-switch-on    # 仅启动 ccr-switch 代理(不重装依赖)
#   bash install.sh --help             # 显示帮助
#
# v1.3.1 修复: 增加参数解析 + 占位符缺失保护 + systemd 服务部署
#                  防止 install.sh 静默替换成功 (用户报告的真实根因)
#
set -euo pipefail

# ── 参数解析 ────────────────────────────────────────────────────────────────
MODE="full"  # full | reinstall | start-only
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reinstall) MODE="reinstall"; shift ;;
    --ccr-switch-on|--start-only) MODE="start-only"; shift ;;
    --help|-h)
      echo "用法: bash install.sh [--reinstall | --ccr-switch-on | --help]"
      echo "  --reinstall        强制重新替换占位符并启动代理"
      echo "  --ccr-switch-on    仅启动 ccr-switch 代理(不重装依赖)"
      echo "  --help             显示此帮助"
      exit 0
      ;;
    *) err "未知参数: $1"; exit 1 ;;
  esac
done

# ── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ── Self-location ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── start-only 模式:跳过全部安装步骤,只启动代理 ────────────────────────────
if [[ "$MODE" == "start-only" ]]; then
  info "模式: start-only (仅启动 ccr-switch 代理)"
  if [[ ! -f "${SCRIPT_DIR}/proxy.js" ]]; then
    err "未找到 ${SCRIPT_DIR}/proxy.js"
    exit 1
  fi
  # 杀掉旧实例
  if pgrep -f "node.*proxy.js.*3456" >/dev/null 2>&1; then
    info "停止旧 ccr 进程..."
    ccr stop 2>/dev/null || true
    sleep 1
    fuser -k 3456/tcp 2>/dev/null || true
    sleep 1
  fi
  # 启动
  nohup node "${SCRIPT_DIR}/proxy.js" 3456 > /tmp/proxy.log 2>&1 &
  sleep 2
  if pgrep -f "node.*proxy.js.*3456" >/dev/null 2>&1; then
    ok "ccr-switch 代理已运行 (PID $(pgrep -f 'node.*proxy.js.*3456' | head -1), 端口 3456)"
  else
    err "代理启动失败,日志: tail /tmp/proxy.log"
    exit 1
  fi
  # 部署 systemd 单元(若可用)
  if [[ -f "${SCRIPT_DIR}/scripts/ccr-switch.service" ]]; then
    info "部署 systemd 单元..."
    install -m 644 "${SCRIPT_DIR}/scripts/ccr-switch.service" /etc/systemd/system/ccr-switch.service 2>/dev/null || warn "无法部署 systemd 单元(可能无 root)"
    systemctl daemon-reload 2>/dev/null || true
    systemctl enable ccr-switch.service 2>/dev/null || true
    ok "systemd 单元已部署(ccr-switch.service)"
  fi
  exit 0
fi

# ── 1. Install / verify CCR CLI ────────────────────────────────────────────
info "检查 @musistudio/claude-code-router..."

if command -v ccr &>/dev/null; then
  ok "@musistudio/claude-code-router 已安装 (ccr $(ccr -v 2>/dev/null || echo '?'))"
else
  info "正在全局安装 @musistudio/claude-code-router..."
  npm install -g "@musistudio/claude-code-router"
  ok "安装完成"
fi

# ── 2. 部署 config.json ────────────────────────────────────────────────────
CCR_DIR="${HOME}/.claude-code-router"
mkdir -p "${CCR_DIR}"

if [[ -f "${SCRIPT_DIR}/config.json" ]]; then
  if [[ -f "${CCR_DIR}/config.json" ]]; then
    cp "${CCR_DIR}/config.json" "${CCR_DIR}/config.json.bak.$(date +%s)"
    warn "已备份旧 config.json"
  fi
  cp "${SCRIPT_DIR}/config.json" "${CCR_DIR}/config.json"
  ok "Config 已复制到 ${CCR_DIR}/config.json"
elif [[ -f "${SCRIPT_DIR}/config.example.json" ]]; then
  if [[ -f "${CCR_DIR}/config.json" ]]; then
    cp "${CCR_DIR}/config.json" "${CCR_DIR}/config.json.bak.$(date +%s)"
    warn "已备份旧 config.json"
  fi
  cp "${SCRIPT_DIR}/config.example.json" "${CCR_DIR}/config.json"
  warn "=============================================="
  warn "  已使用 config.example.json 作为 config.json"
  warn "  请用编辑器填入你的 API key:"
  warn "  vim ${CCR_DIR}/config.json"
  warn "=============================================="
fi

# ── 3. 修补 CCR transformers (兼容旧架构) ──────────────────────────────────
if command -v node &>/dev/null; then
  if [[ -f "${SCRIPT_DIR}/patch.js" ]]; then
    info "运行 patch.js 修补 transformer..."
    node "${SCRIPT_DIR}/patch.js" || warn "patch.js 运行失败(不影响 proxy.js,proxy.js 已独立)"
  fi
else
  err "未找到 node,无法继续"
  exit 1
fi

# ── 4. 部署 presets.json (从模板复制) ─────────────────────────────────────
PRESETS_FILE="${SCRIPT_DIR}/presets.json"
if [[ ! -f "${PRESETS_FILE}" && -f "${SCRIPT_DIR}/presets.example.json" ]]; then
  info "首次安装:从 presets.example.json 复制为 presets.json"
  cp "${SCRIPT_DIR}/presets.example.json" "${PRESETS_FILE}"
  ok "presets.json 已创建(请勿提交到 git)"
fi
if [[ -f "${PRESETS_FILE}" ]]; then
  chmod 600 "${PRESETS_FILE}"
  ok "presets.json 权限已设为 600"
fi

# ── 5. 管理 ~/.claude/dev-flow/credentials.json ────────────────────────────
DEVFLOW_DIR="${HOME}/.claude/dev-flow"
CREDS_FILE="${DEVFLOW_DIR}/credentials.json"
mkdir -p "${DEVFLOW_DIR}"

# 检测已有真 key(从旧 proxy.js 提取 mm key 用于迁移)
OLD_MM_KEY=""
if [[ -f "${SCRIPT_DIR}/proxy.js" ]] && grep -qE "sk-cp-" "${SCRIPT_DIR}/proxy.js"; then
  OLD_MM_KEY=$(grep -oE "sk-cp-[A-Za-z0-9_-]+" "${SCRIPT_DIR}/proxy.js" | head -1 || true)
fi

# 读现有 credentials(若存在)
declare -A CREDS
if [[ -f "${CREDS_FILE}" ]]; then
  while IFS="=" read -r k v; do
    CREDS["$k"]="$v"
  done < <(jq -r 'to_entries | .[] | "\(.key)=\(.value)"' "${CREDS_FILE}" 2>/dev/null || true)
fi

# 迁移:从旧 proxy.js 提取的 mm key,若 credentials.json 还没有,自动填入
if [[ -n "$OLD_MM_KEY" && -z "${CREDS[mm_key]:-}" ]]; then
  info "检测到旧 proxy.js 含 mm key,自动迁移到 credentials.json"
  CREDS[mm_key]="$OLD_MM_KEY"
fi

# 检查缺失的 key,交互式提示
prompt_for_key() {
  local key_name="$1"
  local prompt_msg="$2"
  local current_val="${CREDS[$key_name]:-}"
  if [[ -n "$current_val" ]]; then
    info "$key_name 已存在,跳过 (长度: ${#current_val})"
    return 0
  fi
  echo ""
  echo -e "  ${YELLOW}$prompt_msg${NC}"
  echo -e "  ${YELLOW}(直接回车跳过,稍后可手动编辑 ${CREDS_FILE})${NC}"
  read -r -s input
  if [[ -n "$input" ]]; then
    CREDS["$key_name"]="$input"
    ok "已保存 $key_name"
  else
    warn "跳过 $key_name(脚本会正常运行,但对应 provider 不可用)"
  fi
}

info "检查 ~/.claude/dev-flow/credentials.json 中的 API key..."
prompt_for_key "ds_key" "请输入 DeepSeek API key (sk-...):"
prompt_for_key "mm_key" "请输入 MiniMax API key (sk-cp-...):"
prompt_for_key "bd_key" "请输入 Baidu Qianfan API key (bce-v3/...):"

# 写回 credentials.json
{
  echo "{"
  first=1
  for k in ds_key mm_key bd_key; do
    if [[ -n "${CREDS[$k]:-}" ]]; then
      if [[ $first -eq 0 ]]; then echo ","; fi
      first=0
      printf '  "%s": "%s"' "$k" "${CREDS[$k]}"
    fi
  done
  echo ""
  echo "}"
} > "${CREDS_FILE}"
chmod 600 "${CREDS_FILE}"
ok "credentials.json 已写入(权限 600)"

# ── 6. 替换 proxy.js 中的占位符 ────────────────────────────────────────────
if [[ -f "${SCRIPT_DIR}/proxy.js" ]]; then
  # 占位符缺失保护 (v1.3.1): 如果 proxy.js 中没有占位符,可能是
  # 已被替换过,或被 git checkout 还原为旧版硬编码 key 版
  # 这种情况必须中止,而不是静默成功
  if ! grep -qE '__DS_KEY__|__MM_KEY__|__BD_KEY__' "${SCRIPT_DIR}/proxy.js"; then
    if grep -qE 'sk-cp-[A-Za-z0-9_-]{20,}|bce-v3/ALTAKSP|__DS_KEY_REDACTED__' "${SCRIPT_DIR}/proxy.js"; then
      err "proxy.js 中已含真 key(无占位符),跳过替换"
      err "如需重新部署,请备份现有真 key 后手动删除 proxy.js 再运行 install.sh"
      err "或使用 --reinstall 强制模式"
      [[ "$MODE" != "reinstall" ]] && exit 4
      warn "--reinstall 模式:将备份并重新处理"
    else
      err "proxy.js 中既无占位符也无真 key,文件可能损坏"
      err "请检查 git 状态: cd ${SCRIPT_DIR} && git status proxy.js"
      exit 4
    fi
  fi

  info "替换 proxy.js 中的占位符为真 key..."
  cp "${SCRIPT_DIR}/proxy.js" "${SCRIPT_DIR}/proxy.js.bak.$(date +%s)"
  tmp=$(mktemp)
  sed -e "s|__DS_KEY__|${CREDS[ds_key]:-__DS_KEY_MISSING__}|g" \
      -e "s|__MM_KEY__|${CREDS[mm_key]:-__MM_KEY_MISSING__}|g" \
      -e "s|__BD_KEY__|${CREDS[bd_key]:-__BD_KEY_MISSING__}|g" \
      "${SCRIPT_DIR}/proxy.js" > "$tmp"
  mv "$tmp" "${SCRIPT_DIR}/proxy.js"
  chmod 600 "${SCRIPT_DIR}/proxy.js"

  # 占位符残留检查:替换后必须 0 个占位符
  if grep -qE '__DS_KEY__|__MM_KEY__|__BD_KEY__' "${SCRIPT_DIR}/proxy.js"; then
    err "替换后仍有占位符残留,可能 credentials.json 中 key 包含特殊字符"
    err "请检查 ~/.claude/dev-flow/credentials.json 内容"
    exit 5
  fi
  ok "proxy.js 已替换占位符(权限 600,占位符已全部清空)"
fi

# ── 7. 部署 ccr-switch-off / ccr-switch-on 到 /usr/local/bin ──────────────
info "部署 ccr-switch-off / ccr-switch-on..."
SCRIPTS_DIR="${SCRIPT_DIR}/scripts"
if [[ -d "${SCRIPTS_DIR}" ]]; then
  for s in ccr-switch-off ccr-switch-on; do
    src="${SCRIPTS_DIR}/${s}"
    dst="/usr/local/bin/${s}"
    if [[ -f "$src" ]]; then
      install -m 755 "$src" "$dst"
      ok "已安装 $dst"
    else
      warn "未找到 $src,跳过"
    fi
  done
fi

# ── 8. 追加 .bashrc 段 (由 ccr-switch-on 接管 marker 块) ──────────────────
BASHRC="${HOME}/.bashrc"
MARKER_BEGIN="# >>> ccr-switch managed block (do not edit) >>>"
MARKER_END="# <<< ccr-switch managed block <<<"

# ccr-switch-on 会自动维护此 block。install.sh 首次安装时,若 block 不存在,
# 用 presets.json 的 ccr 段初始化;若已存在,跳过(off/on 已配置好)
if grep -qF "${MARKER_BEGIN}" "${BASHRC}" 2>/dev/null; then
  info ".bashrc managed 块已存在,跳过初始化(由 ccr-switch-on 维护)"
else
  info "初始化 .bashrc managed 块为 ccr 模式..."
  ccr_block=$(jq -r '.ccr.env | to_entries | .[] | "export " + .key + "=" + (.value | tostring)' "${PRESETS_FILE}" 2>/dev/null || true)
  {
    echo ""
    echo "${MARKER_BEGIN}"
    echo "# 当前模式: ccr-switch 代理(直连用 ccr-switch-off [1/2/3/C])"
    echo "${ccr_block}"
    echo "${MARKER_END}"
  } >> "${BASHRC}"
  ok ".bashrc managed 块已初始化"
  info "执行 'source ~/.bashrc' 或新开 shell 以生效"
fi

# ── 9. 启动 ccr-switch 代理 ────────────────────────────────────────────────
info "启动 ccr-switch 代理..."

# 杀掉旧 proxy.js(它仍依赖被替换的 mm key,必须重启)
if pgrep -f "node.*proxy.js.*3456" > /dev/null 2>&1 || pgrep -f "claude-code-router" > /dev/null 2>&1; then
  info "停止旧 ccr 进程..."
  ccr stop 2>/dev/null || true
  sleep 1
  fuser -k 3456/tcp 2>/dev/null || true
  sleep 1
fi

# 直接启动 proxy.js(本机安装模式,不走 ccr cli)
nohup node "${SCRIPT_DIR}/proxy.js" 3456 > /tmp/proxy.log 2>&1 &
sleep 2

if pgrep -f "node.*proxy.js.*3456" > /dev/null 2>&1; then
  ok "ccr-switch 代理已运行 (PID $(pgrep -f 'node.*proxy.js.*3456' | head -1), 端口 3456)"
else
  warn "代理可能未启动,日志: tail /tmp/proxy.log"
fi

# ── 10. 部署 systemd 服务单元 (v1.3.1) ────────────────────────────────────
# 解决 ccr-switch 依赖 cron @reboot 启动的问题:
# 阿里云服务器重启后,systemd 不会自动触发 cron @reboot 任务,
# 导致 ccr-switch 不能自动拉起(用户报告的真实问题)
if [[ -f "${SCRIPT_DIR}/scripts/ccr-switch.service" ]]; then
  info "部署 systemd 单元 (ccr-switch.service)..."
  if install -m 644 "${SCRIPT_DIR}/scripts/ccr-switch.service" /etc/systemd/system/ccr-switch.service 2>/dev/null; then
    systemctl daemon-reload 2>/dev/null || true
    systemctl enable ccr-switch.service 2>/dev/null || true
    ok "systemd 单元已部署并 enable,服务器重启后将自动拉起 ccr-switch"
  else
    warn "无法部署 systemd 单元(需要 root 权限,fallback 到 cron @reboot)"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              ccr-switch v1.3.0 安装完成!                   ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}代理端点:${NC}  http://127.0.0.1:3456"
echo ""
echo -e "  ${CYAN}可用别名:${NC}"
echo -e "    /model ds,v4pro     DeepSeek V4 Pro    (默认, 思考, web)"
echo -e "    /model ds,v4flash   DeepSeek V4 Flash  (后台任务)"
echo -e "    /model mm,m3        MiniMax M3         (测试/文档/提交)"
echo -e "    /model bd,glm5.1    Baidu Qianfan GLM-5.1 (测试/文档/提交)"
echo ""
echo -e "  ${CYAN}代理 ↔ 直连切换:${NC}"
echo -e "    ccr-switch-off [1/2/3/C]   关闭代理,切到直连"
echo -e "    ccr-switch-on              恢复 ccr 代理"
echo -e "    直连预设: [1] ds,v4pro  [2] mm,m3  [3] bd,glm5.1  [C] 自定义"
echo ""
echo -e "  ${CYAN}凭据管理:${NC}"
echo -e "    真 key 存储于 ~/.claude/dev-flow/credentials.json (chmod 600)"
echo -e "    编辑: vi ~/.claude/dev-flow/credentials.json"
echo -e "    重新部署: bash $(basename "$0")"
echo ""
echo -e "  ${YELLOW}提示:${NC} 新开会话或执行 'source ~/.bashrc' 以让环境变量生效"
echo ""
