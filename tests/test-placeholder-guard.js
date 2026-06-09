#!/usr/bin/env node
// ccr-switch v1.3.3 守卫回归测试
// 覆盖:
//   1) 守卫代码自身不字面包含占位符 __DS_KEY__ / __MM_KEY__ / __BD_KEY__ (反自引用)
//   2) 占位符版本启动被守卫拒收(用 proxy.js 占位符版,期望 process.exit(1))
//   3) 守卫 IIFE 函数存在且调用
//   4) PROVIDERS 块使用占位符 (这是 install.sh 替换的目标)
//
// 此测试不需要运行中的代理,只做静态 + 进程启动验证。

var fs = require('fs');
var path = require('path');
var spawnSync = require('child_process').spawnSync;

var PROXY_JS = path.join(__dirname, '..', 'proxy.js');
var FAILED = 0, PASSED = 0;

function test(name, fn) {
  console.log('  TEST: ' + name);
  try { fn(); PASSED++; console.log('    ✅ PASS'); }
  catch(e) { FAILED++; console.log('    ❌ FAIL: ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

var src = fs.readFileSync(PROXY_JS, 'utf8');

// 测试 1:守卫代码自身不字面含占位符 (反自引用)
test('守卫 IIFE 代码自身不字面包含 _KEY 字面量 (反自引用)', function() {
  // 提取 sanityCheckPlaceholder IIFE 范围
  var m = src.match(/sanityCheckPlaceholder[\s\S]*?\}\)\(\)/);
  assert(m, '未找到守卫 IIFE 函数');
  var guard = m[0];
  // 守卫代码区域不应字面包含完整的 _KEY__ (允许 "KEY__" 等片段,因为是动态拼接产物)
  var badHits = ['DS_KEY', 'MM_KEY', 'BD_KEY'].filter(function(k) {
    return guard.indexOf(k) >= 0;
  });
  assert(badHits.length === 0,
    '守卫代码字面含占位符片段: ' + badHits.join(',') + ' — 会导致自引用误判,占位符版本永远无法启动');
});

// 测试 2:占位符版本启动被守卫拒收
test('占位符版本启动时守卫调用 process.exit(1) 拒收', function() {
  // 确认当前 proxy.js 是占位符 (本测试就是守卫上线前的 guard)
  assert(src.indexOf('__DS_KEY__') >= 0, 'proxy.js 已非占位符,本测试不适用 — 守卫已通过,跳到下一个测试');

  // 启动占位符版本,期望 exit code = 1 且 stderr 含 FATAL
  var r = spawnSync(process.execPath, [PROXY_JS, '3458'], { encoding: 'utf8', timeout: 3000 });
  assert(r.status === 1, '占位符版本应被守卫拒启动 (exit=1),实际 status=' + r.status);
  assert(/FATAL.*placeholder|FATAL.*占位符/.test(r.stderr), '守卫输出缺 FATAL 信息: ' + r.stderr);
});

// 测试 3:守卫 IIFE 存在
test('proxy.js 定义 sanityCheckPlaceholder 守卫 IIFE', function() {
  assert(/sanityCheckPlaceholder/.test(src), 'proxy.js 缺少 sanityCheckPlaceholder 守卫函数');
  assert(/\(function[\s\S]*?\}\)\(\)/.test(src), '守卫不是 IIFE 形式 (立即执行函数表达式)');
});

// 测试 4:PROVIDERS 块 key 字段使用占位符 (install.sh 替换目标)
test('PROVIDERS 块 key 字段为占位符 (install.sh 替换目标)', function() {
  assert(/key:\s*'__DS_KEY__'/.test(src), 'ds provider key 缺占位符');
  assert(/key:\s*'__MM_KEY__'/.test(src), 'mm provider key 缺占位符');
  assert(/key:\s*'__BD_KEY__'/.test(src), 'bd provider key 缺占位符');
});

setTimeout(function() {
  console.log('');
  console.log('结果: ' + PASSED + ' 通过, ' + FAILED + ' 失败');
  process.exit(FAILED > 0 ? 1 : 0);
}, 200);
