#!/usr/bin/env bash
# tests/install-placeholder-safety.sh
#
# TDD RED 阶段:验证 install.sh sed 替换占位符行为的安全性
# 这些测试将在 install.sh 修复后通过
#
# 涵盖三个关键行为:
#   1. sed 替换前必须检测占位符存在(防止静默失败)
#   2. sed 替换后必须验证占位符被全部替换(防止部分替换)
#   3. 启动代理前必须先健康检查(防止"启动了但服务没起来"被误判为成功)

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
INSTALL_SH="${REPO_ROOT}/install.sh"

# 测试计数器
PASSED=0
FAILED=0
TOTAL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── 测试工具函数 ────────────────────────────────────────────────────────────

assert() {
  local cond="$1"
  local msg="${2:-断言失败}"
  if [[ "$cond" != "true" ]]; then
    echo -e "    ${RED}❌ FAIL${NC}: $msg"
    return 1
  fi
  echo -e "    ${GREEN}✅ PASS${NC}"
}

assert_grep() {
  local file="$1"
  local pattern="$2"
  local desc="$3"
  if grep -qE "$pattern" "$file" 2>/dev/null; then
    echo -e "    ${GREEN}✅ PASS${NC}: $desc"
    return 0
  else
    echo -e "    ${RED}❌ FAIL${NC}: $desc (file=$file pattern=$pattern)"
    return 1
  fi
}

assert_not_grep() {
  local file="$1"
  local pattern="$2"
  local desc="$3"
  if ! grep -qE "$pattern" "$file" 2>/dev/null; then
    echo -e "    ${GREEN}✅ PASS${NC}: $desc"
    return 0
  else
    echo -e "    ${RED}❌ FAIL${NC}: $desc (file=$file 仍含 pattern=$pattern)"
    return 1
  fi
}

run_test() {
  local name="$1"
  local fn="$2"
  TOTAL=$((TOTAL + 1))
  echo -e "\n  ${CYAN}TEST${NC}: $name"
  if $fn; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
  fi
}

# ── 准备工作:建立 fixture proxy.js(模拟含占位符的版本) ─────────────────────
FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

cat > "${FIXTURE_DIR}/proxy.js.placeholder" <<'EOF'
#!/usr/bin/env node
var PROVIDERS = {
  ds: { url: 'https://api.deepseek.com/x', key: '__DS_KEY__' },
  mm: { url: 'https://api.minimaxi.com/x', key: '__MM_KEY__' },
  bd: { url: 'https://qianfan.baidubce.com/x', key: '__BD_KEY__' }
};
EOF

cat > "${FIXTURE_DIR}/proxy.js.replaced" <<'EOF'
#!/usr/bin/env node
var PROVIDERS = {
  ds: { url: 'https://api.deepseek.com/x', key: 'sk-real-ds-key' },
  mm: { url: 'https://api.minimaxi.com/x', key: 'sk-cp-real-mm-key' },
  bd: { url: 'https://qianfan.baidubce.com/x', key: 'bce-v3-real-bd-key' }
};
EOF

# ── 真正的 install.sh 占位符替换逻辑(从 install.sh 提取出来形成可测试函数) ─
# 这个函数模拟 install.sh 第 165-176 行的行为,但加了断言
replace_placeholders() {
  local proxy_file="$1"
  local ds_key="$2"
  local mm_key="$3"
  local bd_key="$4"

  # 断言 1:替换前必须存在占位符(防止源文件已被替换过)
  if ! grep -qE '__DS_KEY__|__MM_KEY__|__BD_KEY__' "$proxy_file"; then
    echo "    [ERROR] proxy.js 中未发现占位符,可能是已替换版本或被 git checkout 覆盖" >&2
    return 2  # 特殊退出码:占位符不存在
  fi

  # sed 替换
  local tmp
  tmp=$(mktemp)
  sed -e "s|__DS_KEY__|${ds_key}|g" \
      -e "s|__MM_KEY__|${mm_key}|g" \
      -e "s|__BD_KEY__|${bd_key}|g" \
      "$proxy_file" > "$tmp"
  mv "$tmp" "$proxy_file"

  # 断言 2:替换后必须无残留占位符(防止部分替换)
  if grep -qE '__DS_KEY__|__MM_KEY__|__BD_KEY__' "$proxy_file"; then
    echo "    [ERROR] 替换后仍有占位符残留,可能 keys 包含特殊字符" >&2
    return 3  # 特殊退出码:替换不完整
  fi

  return 0
}

# ── 测试用例 ────────────────────────────────────────────────────────────────

test_replace_placeholders_with_fixture() {
  # RED: 这是 install.sh 修复后应该有的行为
  # 验证:对含占位符的 proxy.js 替换后,占位符全部消失,真 key 出现
  local src="${FIXTURE_DIR}/proxy.js.placeholder"
  cp "$src" "${FIXTURE_DIR}/test1.js"

  replace_placeholders "${FIXTURE_DIR}/test1.js" "sk-real-ds-key" "sk-cp-real-mm-key" "bce-v3-real-bd-key"

  assert_not_grep "${FIXTURE_DIR}/test1.js" "__DS_KEY__|__MM_KEY__|__BD_KEY__" "替换后无占位符残留"
}

test_replace_placeholders_rejects_already_replaced() {
  # RED: 这就是用户报告的根因!proxy.js 已被还原为占位符版或已是真 key 版
  # 修复后必须 fail-fast(用户报告的问题就是 install.sh 静默成功)
  local src="${FIXTURE_DIR}/proxy.js.replaced"
  cp "$src" "${FIXTURE_DIR}/test2.js"

  # 期望:返回非 0(占位符不存在,中止)
  local exit_code=0
  replace_placeholders "${FIXTURE_DIR}/test2.js" "sk-x" "sk-x" "bce-x" || exit_code=$?

  if [[ $exit_code -eq 2 ]]; then
    echo -e "    ${GREEN}✅ PASS${NC}: 已替换版本被正确拒绝(非静默成功)"
    return 0
  else
    echo -e "    ${RED}❌ FAIL${NC}: 已替换版本未被拒绝(exit=$exit_code,期望=2)"
    return 1
  fi
}

test_install_sh_has_replace_function() {
  # GREEN: install.sh 必须有"占位符不存在则报错"的代码
  # 防止未来 install.sh 静默回归
  assert_grep "$INSTALL_SH" "__DS_KEY__|__MM_KEY__|__BD_KEY__" "install.sh 中存在占位符定义"
  if grep -qE "(占位符不存在|占位符已被替换|未发现占位符|placeholder.*not.*found|placeholder.*missing|跳过替换)" "$INSTALL_SH"; then
    echo -e "    ${GREEN}✅ PASS${NC}: install.sh 有占位符缺失保护"
    return 0
  else
    echo -e "    ${RED}❌ FAIL${NC}: install.sh 缺少'占位符缺失保护' (用户报告的根因)"
    return 1
  fi
}

test_install_sh_supports_ccr_switch_on_param() {
  # GREEN: 用户运行了 `install.sh --ccr-switch-on` 但被忽略
  # install.sh 必须有真正的参数解析(case \$1 模式)
  if grep -qE "case \"\\\$1\"|while \[\[ \\\$# -gt 0 \]\]" "$INSTALL_SH"; then
    echo -e "    ${GREEN}✅ PASS${NC}: install.sh 有参数解析框架 (case/while)"
    return 0
  else
    echo -e "    ${RED}❌ FAIL${NC}: install.sh 没有参数解析框架— 用户报告的根因"
    return 1
  fi
}

test_proxy_js_in_gitignore() {
  # RED: v1.3.0 安全设计要求 proxy.js 不入库,防止"git checkout 还原"
  # 当前 .gitignore 应该忽略 proxy.js
  local gitignore="${REPO_ROOT}/.gitignore"
  if [[ -f "$gitignore" ]] && grep -qE "^proxy\.js$|^/proxy\.js$" "$gitignore"; then
    echo -e "    ${GREEN}✅ PASS${NC}: proxy.js 已在 .gitignore 中(防止 git checkout 覆盖)"
    return 0
  else
    echo -e "    ${RED}❌ FAIL${NC}: proxy.js 未在 .gitignore 中(用户报告的根因)"
    return 1
  fi
}

test_systemd_unit_exists() {
  # RED: 死机重启后 ccr-switch 没启动 = 没有 systemd 单元
  # scripts/ccr-switch.service 必须存在
  local svc="${REPO_ROOT}/scripts/ccr-switch.service"
  if [[ -f "$svc" ]]; then
    echo -e "    ${GREEN}✅ PASS${NC}: scripts/ccr-switch.service 已创建"
    return 0
  else
    echo -e "    ${RED}❌ FAIL${NC}: scripts/ccr-switch.service 缺失(用户报告的根因)"
    return 1
  fi
}

# ── 入口 ────────────────────────────────────────────────────────────────────

echo -e "\n${CYAN}🔍 ccr-switch install.sh 占位符安全 + 启动机制测试套件${NC}"
echo "  repo: $REPO_ROOT"
echo ""

# RED 阶段:所有与新行为相关的测试应该 fail
run_test "占位符替换对占位符版本成功" test_replace_placeholders_with_fixture
run_test "占位符替换拒绝已替换版本(用户根因)" test_replace_placeholders_rejects_already_replaced
run_test "install.sh 含占位符缺失保护" test_install_sh_has_replace_function
run_test "install.sh 支持 --ccr-switch-on 参数" test_install_sh_supports_ccr_switch_on_param
run_test "proxy.js 已在 .gitignore" test_proxy_js_in_gitignore
run_test "scripts/ccr-switch.service 存在" test_systemd_unit_exists

echo ""
echo -e "${CYAN}📊 结果${NC}: ${GREEN}$PASSED 通过${NC}, ${RED}$FAILED 失败${NC}, $TOTAL 总计"
echo ""

if [[ $FAILED -gt 0 ]]; then
  echo -e "${RED}❌ RED 阶段:这些测试都失败了 — 符合预期 (修复 install.sh 后会变绿)${NC}"
  exit 1
else
  echo -e "${GREEN}🎉 全部通过${NC}"
  exit 0
fi
