#!/usr/bin/env node
/**
 * patch.js — Minimal CCR patches for model name mapping.
 * Only 3 changes needed when using Anthropic-compatible endpoints.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function resolveCliJs() {
  const root = require("child_process").execSync("npm root -g", { encoding: "utf8" }).trim();
  return path.join(root, "@musistudio/claude-code-router/dist/cli.js");
}

const cliJs = resolveCliJs();
console.log("[patch] CCR:", cliJs);

let code = fs.readFileSync(cliJs, "utf8");
const originalHash = crypto.createHash("sha256").update(code).digest("hex").slice(0, 12);

// 1. DeepSeek transformer: model name mapping
code = code.replace(
  /async\s+transformRequestIn\s*\(\s*e\s*\)\s*\{return\s+e\.max_tokens\s*&&\s*e\.max_tokens\s*>\s*8192\s*&&\s*\(\s*e\.max_tokens\s*=\s*8192\s*\),\s*e\s*\}/,
  'async transformRequestIn(e){const map={v4pro:"deepseek-v4-pro",v4flash:"deepseek-v4-flash","m2.7":"MiniMax-M2.7"};map[e.model]&&(e.model=map[e.model]);e.max_tokens&&e.max_tokens>8192&&(e.max_tokens=8192);return e}'
);
console.log("[patch] 1/3 DeepSeek model mapping");

// 2. Anthropic transformer: model name mapping
if (!/name="Anthropic"[^}]*transformRequestIn[^}]*map/.test(code)) {
  const m = 'v4pro:"deepseek-v4-pro",v4flash:"deepseek-v4-flash","m2.7":"MiniMax-M2.7"';
  code = code.replace(
    /(useBearer;logger;)async\s+auth\s*\(\s*e\s*,\s*t\s*\)\s*\{/,
    '$1async transformRequestIn(e){const map={' + m + '};return map[e.model]&&(e.model=map[e.model]),e}async auth(e,t){'
  );
  console.log("[patch] 2/3 Anthropic model mapping");
}

// 3. fD function: comprehensive model name mapping
const MAP = '{v4pro:"deepseek-v4-pro",v4flash:"deepseek-v4-flash","m2.7":"MiniMax-M2.7","deepseek-v4-pro":"deepseek-v4-pro","deepseek-v4-flash":"deepseek-v4-flash","MiniMax-M2.7":"MiniMax-M2.7","claude-sonnet-4-6":"deepseek-v4-pro","claude-haiku-4-5":"deepseek-v4-flash","claude-opus-4-7":"deepseek-v4-pro"}';
code = code.replace(
  "let a=t.url||new URL(r.baseUrl);",
  'let a=t.url||new URL(r.baseUrl);var _m=' + MAP + ';if(_m[e.model])e.model=_m[e.model];else{var _p=e.model.split(",").pop();if(_m[_p])e.model=_m[_p]}'
);
console.log("[patch] 3/3 fD model mapping");

// Write if changed
const newHash = crypto.createHash("sha256").update(code).digest("hex").slice(0, 12);
if (originalHash === newHash) {
  console.log("[patch] Already up to date");
  process.exit(0);
}

fs.copyFileSync(cliJs, cliJs + ".bak." + originalHash);
fs.writeFileSync(cliJs, code);
console.log("[patch] Done. Backup:", path.basename(cliJs) + ".bak." + originalHash);
