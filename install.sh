#!/usr/bin/env bash
{ set +x; } 2>/dev/null
set -euo pipefail
info(){ printf '[INFO] %s\n' "$*"; }; fail(){ printf '[ERROR] %s\n' "$*" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; INSTALL_DIR="${CCR_SWITCH_INSTALL_DIR:-$HOME/.local/share/ccr-switch}"; CONFIG_DIR="$HOME/.config/ccr-switch"; CREDS_FILE="$CONFIG_DIR/credentials.json"; CONFIG_FILE="$CONFIG_DIR/config.json"; MODE=install
while [[ $# -gt 0 ]]; do case "$1" in --reinstall) MODE=install;; --ccr-switch-on|--start-only) MODE=start;; --help|-h) printf '用法：bash install.sh [--reinstall|--ccr-switch-on]\n'; exit 0;; *) fail "未知参数：$1";; esac; shift; done
[[ "$MODE" != start ]] || exec "$INSTALL_DIR/scripts/ccr-switch-on"
command -v node >/dev/null 2>&1 || fail '未找到 Node.js'; SYSTEMD_MODE="${CCR_SWITCH_USE_SYSTEMD:-0}"; [[ "$SYSTEMD_MODE" != 1 ]] || command -v systemctl >/dev/null 2>&1 || fail '未找到 systemctl'; umask 077
# 在任何创建、chmod、锁或清理前，不跟随 symlink 验证全部内部父路径。
SYSTEMD_DIR="$HOME/.config/systemd"; UNIT_DIR="$SYSTEMD_DIR/user"
node - "$CONFIG_DIR" "$INSTALL_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/scripts" "$SYSTEMD_DIR" "$UNIT_DIR" <<'NODE' || fail '路径边界非法：存在 symlink、非目录或非当前用户所有'
const fs=require('fs'),path=require('path'),uid=process.getuid();
for(const target of process.argv.slice(2)){let cur=path.parse(path.resolve(target)).root;for(const part of path.resolve(target).slice(cur.length).split(path.sep).filter(Boolean)){cur=path.join(cur,part);try{const s=fs.lstatSync(cur);if(s.isSymbolicLink()||!s.isDirectory()||s.uid!==uid)process.exit(1)}catch(e){if(e.code==='ENOENT')break;throw e}}}
NODE
mkdir -p "$CONFIG_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/scripts"; [[ "$SYSTEMD_MODE" != 1 ]] || mkdir -p "$UNIT_DIR"; chmod 700 "$CONFIG_DIR"
node - "$CONFIG_DIR" "$INSTALL_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/scripts" <<'NODE' || fail '创建后的路径边界验证失败'
const fs=require('fs');for(const p of process.argv.slice(2)){const s=fs.lstatSync(p);if(s.isSymbolicLink()||!s.isDirectory()||s.uid!==process.getuid())process.exit(1)}
NODE
guard_file(){ node -e 'const fs=require("fs"),p=process.argv[1],strict=process.argv[2]==="1";try{const s=fs.lstatSync(p);if(s.isSymbolicLink()||!s.isFile()||s.uid!==process.getuid()||(strict&&(s.mode&0o077)!==0))process.exit(1)}catch(e){if(e.code!=="ENOENT")throw e}' "$1" "${2:-0}" || fail '正式目标非法：必须是当前用户所有的普通文件且不得为 symlink'; }
for f in "$CREDS_FILE:1" "$CONFIG_FILE:1" "$INSTALL_DIR/proxy.js:0" "$INSTALL_DIR/lib/receipt-index.js:0" "$INSTALL_DIR/config.example.json:0" "$INSTALL_DIR/presets.example.json:0" "$INSTALL_DIR/VERSION:0" "$INSTALL_DIR/scripts/ccr-switch-on:0" "$INSTALL_DIR/scripts/ccr-switch-off:0" "$INSTALL_DIR/scripts/ccr-switch-status:0" "$INSTALL_DIR/ccr-switch.service:0" "$UNIT_DIR/ccr-switch.service:0"; do guard_file "${f%:*}" 0; done
LOCK_DIR="$CONFIG_DIR/.ccr-switch-install.lock"; lock_owned=0
proc_starttime(){ [[ "$1" =~ ^[0-9]+$ && -r "/proc/$1/stat" ]] || return 1; node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8"),i=s.lastIndexOf(") "),f=s.slice(i+2).split(" ");process.stdout.write(f[19]||"")' "/proc/$1/stat"; }
release_lock(){
  if [[ "$lock_owned" == 1 && -d "$LOCK_DIR" && ! -L "$LOCK_DIR" && -f "$LOCK_DIR/owner" && ! -L "$LOCK_DIR/owner" ]]; then
    read -r p s n <"$LOCK_DIR/owner" || true
    if [[ "$p" == "$$" && "$s" == "${start:-}" && "$n" == "${nonce:-}" ]]; then rm -f "$LOCK_DIR/owner"; rmdir "$LOCK_DIR" 2>/dev/null || true; fi
  fi
  lock_owned=0
}
acquire_lock(){
  local attempts=0
  while (( attempts++ < 100 )); do
    nonce="$$.$RANDOM.$RANDOM"; publish="$CONFIG_DIR/.ccr-switch-lock-publish.$nonce"
    if mkdir -m 700 "$publish" 2>/dev/null; then
      start="$(proc_starttime "$$")" || { rmdir "$publish"; fail '无法读取安装进程身份'; }
      printf '%s %s %s\n' "$$" "$start" "$nonce" >"$publish/owner"; chmod 600 "$publish/owner"
      if [[ -n "${CCR_SWITCH_TEST_LOCK_BEFORE_PUBLISH:-}" ]]; then : >"$CCR_SWITCH_TEST_LOCK_BEFORE_PUBLISH"; while [[ ! -e "${CCR_SWITCH_TEST_LOCK_PUBLISH_CONTINUE:-}" ]]; do sleep .02; done; fi
      if mv -T "$publish" "$LOCK_DIR" 2>/dev/null; then
        lock_owned=1
        if [[ -n "${CCR_SWITCH_TEST_LOCK_PUBLISHED:-}" ]]; then : >"$CCR_SWITCH_TEST_LOCK_PUBLISHED"; while [[ ! -e "${CCR_SWITCH_TEST_LOCK_CONTINUE:-}" ]]; do sleep .02; done; fi
        return 0
      fi
      rm -f "$publish/owner"; rmdir "$publish" 2>/dev/null || true
    fi
    if [[ -e "$LOCK_DIR" ]]; then
      [[ ! -L "$LOCK_DIR" && -d "$LOCK_DIR" ]] || fail '安装锁路径非法，拒绝继续'
      # owner 缺失/不完整绝不视为 stale，有限重试确认发布状态。
      [[ ! -L "$LOCK_DIR/owner" ]] || fail '安装锁 owner 为 symlink，拒绝继续'
      if [[ ! -f "$LOCK_DIR/owner" ]]; then sleep .03; continue; fi
      owner_pid=''; owner_start=''; owner_nonce=''; read -r owner_pid owner_start owner_nonce <"$LOCK_DIR/owner" || { sleep .03; continue; }
      [[ -n "$owner_nonce" ]] || { sleep .03; continue; }
      current_start="$(proc_starttime "$owner_pid" 2>/dev/null || true)"
      if [[ -n "$current_start" && "$current_start" == "$owner_start" ]]; then fail '另一个 ccr-switch 安装正在进行，安装锁被占用'; fi
      stale="$CONFIG_DIR/.ccr-switch-lock-stale.$nonce"
      if mv -T "$LOCK_DIR" "$stale" 2>/dev/null; then rm -f "$stale/owner"; rmdir "$stale" 2>/dev/null || true; fi
      continue
    fi
  done
  fail '安装锁状态不完整或竞争繁忙，拒绝继续'
}
acquire_lock
for key_file in "$CREDS_FILE" "$CONFIG_FILE"; do if [[ -f "$key_file" ]]; then chmod 600 "$key_file"; guard_file "$key_file" 1; info "已收紧 $(basename "$key_file") 权限为 0600"; fi; done
node - "$CONFIG_DIR" "$INSTALL_DIR" <<'NODE' || fail '命名空间含 symlink 或非预期 inode，拒绝清理'
const fs=require('fs'),path=require('path');for(const [d,re] of [[process.argv[2],/^\.ccr-switch-(credentials|config)\./],[process.argv[3],/^\.ccr-switch-transaction\./]])for(const n of fs.readdirSync(d)){if(!re.test(n))continue;const s=fs.lstatSync(path.join(d,n));if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory()))process.exit(1)}
NODE
node - "$INSTALL_DIR" <<'NODE' || fail 'stale 事务结构或 inode 非法，拒绝清理'
const fs=require('fs'),path=require('path'),uid=process.getuid(),dirs=new Set(['','backup','stage','stage/app','stage/app/lib','stage/app/scripts']),files=/^(backup\/\d+|stage\/app\/(proxy\.js|config\.example\.json|presets\.example\.json|VERSION|ccr-switch\.service|lib\/receipt-index\.js|scripts\/(ccr-switch-on|ccr-switch-off|ccr-switch-status)))$/;
function clean(root){const base=fs.lstatSync(root),dev=base.dev;if(base.isSymbolicLink()||!base.isDirectory()||base.uid!==uid)throw Error('root');const entries=[];function validate(d,rel){for(const n of fs.readdirSync(d)){const p=path.join(d,n),r=path.join(rel,n),s=fs.lstatSync(p);if(s.uid!==uid||s.dev!==dev||s.isSymbolicLink())throw Error('inode');if(s.isDirectory()){if(!dirs.has(r))throw Error('extra-dir');entries.push([p,true]);validate(p,r)}else{if(!s.isFile())throw Error('special');if(!files.test(r))throw Error('extra-file');entries.push([p,false])}}}validate(root,'');for(const [p,isDir] of entries.reverse())isDir?fs.rmdirSync(p):fs.unlinkSync(p);fs.rmdirSync(root)}
for(const n of fs.readdirSync(process.argv[2]))if(/^\.ccr-switch-transaction\./.test(n))clean(path.join(process.argv[2],n));
NODE
find "$CONFIG_DIR" -maxdepth 1 -type f \( -name '.ccr-switch-credentials.*' -o -name '.ccr-switch-config.*' \) -delete
TXN="$(mktemp -d "$INSTALL_DIR/.ccr-switch-transaction.XXXXXX")"; BACKUP="$TXN/backup"; STAGE="$TXN/stage"; mkdir -p "$BACKUP" "$STAGE/app/lib" "$STAGE/app/scripts"
KEY_CRED_STAGE="$(mktemp "$CONFIG_DIR/.ccr-switch-credentials.XXXXXX")"; KEY_CONFIG_STAGE="$(mktemp "$CONFIG_DIR/.ccr-switch-config.XXXXXX")"
TARGETS=(); STAGED=(); EXISTED=(); BACKUPS=(); BACKUP_META=(); ORIGINAL_MODES=(); COMMITTED_IDS=(); transaction_active=1; manager_touched=0; restore_mismatch=0
cleanup(){ rm -f "$KEY_CRED_STAGE" "$KEY_CONFIG_STAGE"; local i b; for ((i=0;i<${#BACKUPS[@]};i++)); do b="${BACKUPS[$i]}"; node -e 'try{const fs=require("fs"),crypto=require("crypto"),path=require("path"),p=process.argv[1],want=process.argv[2],fd=fs.openSync(p,"r"),s=fs.fstatSync(fd),buf=fs.readFileSync(fd),d=fs.lstatSync(path.dirname(p));fs.closeSync(fd);const got=[s.dev,s.ino,s.uid,s.mode&511,s.size,d.dev,d.ino,crypto.createHash("sha256").update(buf).digest("hex")].join(":");if(got===want)fs.unlinkSync(p)}catch(e){}' "$b" "${BACKUP_META[$i]:-}"; done; [[ ! -d "$TXN" ]] || node -e 'const fs=require("fs");fs.rmSync(process.argv[1],{recursive:true})' "$TXN"; release_lock; }
restore_nonkey(){ local i target backup id current; for ((i=${#COMMITTED_IDS[@]}-1;i>=0;i--)); do target="${TARGETS[$i]}"; backup="${BACKUPS[$i]}"; current="$(node -e 'try{const s=require("fs").lstatSync(process.argv[1]);if(s.isSymbolicLink()||!s.isFile()||s.uid!==process.getuid())process.exit(1);process.stdout.write(s.dev+":"+s.ino)}catch(e){process.exit(1)}' "$target" 2>/dev/null || true)"; id="${COMMITTED_IDS[$i]}"; if [[ "$current" != "$id" ]]; then printf '[ERROR] 高严重度：正式目标状态不一致，拒绝触碰未知 inode\n' >&2; restore_mismatch=1; continue; fi; if [[ "${EXISTED[$i]}" == 1 ]]; then if ! node -e 'const fs=require("fs"),crypto=require("crypto"),path=require("path"),p=process.argv[1],t=process.argv[2],want=process.argv[3],orig=Number(process.argv[4]);if(typeof fs.constants.O_NOFOLLOW!=="number")process.exit(4);const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),s=fs.fstatSync(fd),b=fs.readFileSync(fd),d=fs.lstatSync(path.dirname(p)),got=[s.dev,s.ino,s.uid,s.mode&511,s.size,d.dev,d.ino,crypto.createHash("sha256").update(b).digest("hex")].join(":");if(got!==want)process.exit(3);fs.fchmodSync(fd,orig);const s2=fs.fstatSync(fd);if(s2.dev!==s.dev||s2.ino!==s.ino||s2.uid!==s.uid||s2.size!==s.size||(s2.mode&511)!==orig)process.exit(3);const lp=fs.lstatSync(p),lt=fs.lstatSync(t);if(lp.isSymbolicLink()||lp.dev!==s.dev||lp.ino!==s.ino||lt.isSymbolicLink()||!lt.isFile()||lt.dev+":"+lt.ino!==process.argv[5])process.exit(3);fs.closeSync(fd);fs.renameSync(p,t)' "$backup" "$target" "${BACKUP_META[$i]}" "${ORIGINAL_MODES[$i]}" "$id"; then printf '[ERROR] 高严重度：backup 状态不一致，拒绝安装未知内容\n' >&2; restore_mismatch=1; continue; fi; else rm -f "$target"; if ! node -e 'const fs=require("fs"),crypto=require("crypto"),path=require("path"),p=process.argv[1],want=process.argv[2],fd=fs.openSync(p,"r"),s=fs.fstatSync(fd),b=fs.readFileSync(fd),d=fs.lstatSync(path.dirname(p));fs.closeSync(fd);const got=[s.dev,s.ino,s.uid,s.mode&511,s.size,d.dev,d.ino,crypto.createHash("sha256").update(b).digest("hex")].join(":");if(got!==want)process.exit(3);fs.unlinkSync(p)' "$backup" "${BACKUP_META[$i]}"; then printf '[ERROR] 高严重度：backup 状态不一致，拒绝删除未知 inode\n' >&2; restore_mismatch=1; fi; fi; done; }
rollback_once(){ local requested="${1:-1}" reload_failed=0; [[ "$transaction_active" == 1 ]] || return "$requested"; transaction_active=0; trap - EXIT; trap '' INT TERM; [[ ! -d "$TXN" ]] || restore_nonkey; if [[ "$restore_mismatch" == 1 ]]; then if [[ "$SYSTEMD_MODE" == 1 && "$manager_touched" == 1 ]]; then if ! systemctl --user daemon-reload >/dev/null 2>&1; then reload_failed=1; printf '[ERROR] 高严重度：systemd manager 恢复 reload 失败，内存状态可能不一致\n' >&2; fi; fi; cleanup; return 3; fi; if [[ "$SYSTEMD_MODE" == 1 && "$manager_touched" == 1 ]]; then systemctl --user daemon-reload >/dev/null 2>&1 || reload_failed=1; fi; cleanup; if [[ "$reload_failed" == 1 ]]; then printf '[ERROR] 高严重度：磁盘旧 unit 已恢复，但 systemd manager 恢复 reload 失败\n' >&2; return 2; fi; return "$requested"; }
on_exit(){ local status=$?; if [[ "$transaction_active" == 1 ]]; then rollback_once "$status"; exit $?; fi; exit "$status"; }
trap on_exit EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
xa_key=''; if [[ -f "$CREDS_FILE" ]]; then xa_key="$(node -e 'try{const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(typeof v.xa_key==="string"?v.xa_key:"")}catch(e){process.exit(1)}' "$CREDS_FILE")" || fail '凭据 JSON 非法'; fi
if [[ -z "$xa_key" ]]; then printf '请输入 xa_key（输入隐藏）：' >&2; IFS= read -r -s xa_key; printf '\n' >&2; fi; [[ -n "$xa_key" ]] || fail 'xa_key 不能为空'
node -e 'const fs=require("fs"),k=fs.readFileSync(0,"utf8").replace(/\n$/,"");fs.writeFileSync(process.argv[1],JSON.stringify({xa_key:k},null,2)+"\n",{mode:0o600})' "$KEY_CRED_STAGE" <<<"$xa_key"
node -e 'const fs=require("fs"),k=fs.readFileSync(0,"utf8").replace(/\n$/,""),c=JSON.parse(fs.readFileSync(process.argv[2],"utf8")),p=c.Providers.find(x=>x.name==="xa");if(!p)throw Error("示例配置缺少 xa provider");p.api_key=k;c.Providers=[p];const bindings={};for(const [wire,target] of Object.entries(c.ModelBindings||{}))if(target.startsWith("xa,"))bindings[wire]=target;c.ModelBindings=bindings;delete c.Router;fs.writeFileSync(process.argv[1],JSON.stringify(c,null,2)+"\n",{mode:0o600})' "$KEY_CONFIG_STAGE" "$SCRIPT_DIR/config.example.json" <<<"$xa_key"
chmod 600 "$KEY_CRED_STAGE" "$KEY_CONFIG_STAGE"; node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$KEY_CRED_STAGE"; node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$KEY_CONFIG_STAGE"
install -m 755 "$SCRIPT_DIR/proxy.js" "$STAGE/app/proxy.js"; install -m 644 "$SCRIPT_DIR/lib/receipt-index.js" "$STAGE/app/lib/receipt-index.js"; install -m 644 "$SCRIPT_DIR/config.example.json" "$STAGE/app/config.example.json"; install -m 644 "$SCRIPT_DIR/presets.example.json" "$STAGE/app/presets.example.json"; install -m 644 "$SCRIPT_DIR/VERSION" "$STAGE/app/VERSION"
for name in ccr-switch-on ccr-switch-off ccr-switch-status; do install -m 755 "$SCRIPT_DIR/scripts/$name" "$STAGE/app/scripts/$name"; done
node -e 'const fs=require("fs");let s=fs.readFileSync(process.argv[1],"utf8");s=s.replaceAll("@INSTALL_DIR@",process.argv[2]).replaceAll("@HOME@",process.env.HOME);fs.writeFileSync(process.argv[3],s,{mode:0o600})' "$SCRIPT_DIR/scripts/ccr-switch.service" "$INSTALL_DIR" "$STAGE/app/ccr-switch.service"
add_nonkey(){ guard_file "$1" 0; TARGETS+=("$1"); STAGED+=("$2"); local parent backup meta original_mode i=$((${#TARGETS[@]}-1)); parent="$(dirname "$1")"; mkdir -p "$parent"; backup="$(mktemp "$parent/.ccr-switch-backup.XXXXXX")"; BACKUPS+=("$backup"); if [[ -f "$1" ]]; then EXISTED+=(1); original_mode="$(node -e 'process.stdout.write(String(require("fs").lstatSync(process.argv[1]).mode&511))' "$1")"; cp -p "$1" "$backup"; else EXISTED+=(0); original_mode=0; : >"$backup"; fi; ORIGINAL_MODES+=("$original_mode"); chmod 400 "$backup"; meta="$(node -e 'const fs=require("fs"),crypto=require("crypto"),path=require("path"),p=process.argv[1],fd=fs.openSync(p,"r"),s=fs.fstatSync(fd),b=fs.readFileSync(fd),d=fs.lstatSync(path.dirname(p));fs.closeSync(fd);process.stdout.write([s.dev,s.ino,s.uid,s.mode&511,s.size,d.dev,d.ino,crypto.createHash("sha256").update(b).digest("hex")].join(":"))' "$backup")"; BACKUP_META+=("$meta"); }
for rel in proxy.js lib/receipt-index.js config.example.json presets.example.json VERSION scripts/ccr-switch-on scripts/ccr-switch-off scripts/ccr-switch-status ccr-switch.service; do add_nonkey "$INSTALL_DIR/$rel" "$STAGE/app/$rel"; done
UNIT_FILE="$HOME/.config/systemd/user/ccr-switch.service"; [[ "$SYSTEMD_MODE" != 1 ]] || add_nonkey "$UNIT_FILE" "$STAGE/app/ccr-switch.service"
for ((i=0;i<${#TARGETS[@]};i++)); do guard_file "${TARGETS[$i]}" 0; cp -p "${STAGED[$i]}" "${TARGETS[$i]}"; COMMITTED_IDS+=("$(node -e 'const s=require("fs").lstatSync(process.argv[1]);process.stdout.write(s.dev+":"+s.ino)' "${TARGETS[$i]}")"); done
if [[ "$SYSTEMD_MODE" == 1 ]]; then manager_touched=1; if [[ -n "${CCR_SWITCH_TEST_RELOAD_READY:-}" ]]; then : >"$CCR_SWITCH_TEST_RELOAD_READY"; while [[ ! -e "${CCR_SWITCH_TEST_RELOAD_CONTINUE:-}" ]]; do sleep .01; done; fi; if ! systemctl --user daemon-reload >/dev/null 2>&1; then rollback_once 1; status=$?; [[ "$status" == 2 ]] || printf '[ERROR] systemd user unit 重新加载失败，已恢复旧状态\n' >&2; exit "$status"; fi; fi
if [[ "${CCR_SWITCH_TEST_FAIL_CONFIG:-0}" == 1 ]]; then rollback_once 1; status=$?; printf '[ERROR] 模拟配置生成失败，已恢复旧状态\n' >&2; exit "$status"; fi
if [[ -n "${CCR_SWITCH_TEST_READY:-}" ]]; then : >"$CCR_SWITCH_TEST_READY"; while [[ ! -e "${CCR_SWITCH_TEST_CONTINUE:-}" ]]; do sleep 0.02; done; fi
if [[ "${CCR_SWITCH_TEST_FAIL_AFTER_READY:-0}" == 1 ]]; then rollback_once 1; exit $?; fi
if [[ -n "${CCR_SWITCH_TEST_BEFORE_CRED:-}" ]]; then : >"$CCR_SWITCH_TEST_BEFORE_CRED"; while [[ ! -e "${CCR_SWITCH_TEST_AFTER_CRED:-}" ]]; do sleep .01; done; fi
guard_file "$CREDS_FILE" 1; guard_file "$CONFIG_FILE" 1
mv -f "$KEY_CRED_STAGE" "$CREDS_FILE"
if [[ -n "${CCR_SWITCH_TEST_BEFORE_CONFIG:-}" ]]; then : >"$CCR_SWITCH_TEST_BEFORE_CONFIG"; while [[ ! -e "${CCR_SWITCH_TEST_AFTER_CONFIG:-}" ]]; do sleep .01; done; fi
[[ -z "${CCR_SWITCH_TEST_RENAME_DELAY_MS:-}" ]] || sleep "$(node -e 'process.stdout.write(String(Number(process.argv[1])/1000))' "$CCR_SWITCH_TEST_RENAME_DELAY_MS")"; mv -f "$KEY_CONFIG_STAGE" "$CONFIG_FILE"
transaction_active=0; trap - EXIT INT TERM; cleanup; info 'ccr-switch 已安全安装，凭据与配置已分别原子提交'
	if [[ "${CCR_SWITCH_SKIP_START:-0}" != 1 ]]; then
	  if ! "$INSTALL_DIR/scripts/ccr-switch-on"; then
	    printf '[ERROR] 安装完成但代理启动失败\n' >&2
	    exit 2
	  fi
	fi
