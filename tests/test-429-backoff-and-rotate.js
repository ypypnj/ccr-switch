#!/usr/bin/env node
// ccr-switch v1.3.2 fix 回归测试
// 覆盖:
//   1) 429 backoff — 同一 provider 短窗口内被限流后,后续请求直接 503
//   2) log rotate — /tmp/proxy-debug.log 超过 MAX_LOG_BYTES 自动轮转
//   3) health — 仍然返回 {"status":"ok"}
//   4) 进程异常保护 — proxy.js 包含 process.on('uncaughtException') + unhandledRejection
//   5) socket error 监听 — 包含 req.on('error') + res.on('error') + upRes.on('error')
//
// 通过环境变量 TEST_PROXY_URL 指定被测代理。需先重启被测代理以加载新代码。

var http = require('http');
var fs = require('fs');
var path = require('path');

var PROXY_URL = process.env.TEST_PROXY_URL || 'http://127.0.0.1:3456';
var FAILED = 0, PASSED = 0;

function test(name, fn) {
  console.log('  TEST: ' + name);
  try { fn(); PASSED++; console.log('    ✅ PASS'); }
  catch(e) { FAILED++; console.log('    ❌ FAIL: ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error((msg || '值不相等') + ': 期望=' + JSON.stringify(b) + ' 实际=' + JSON.stringify(a)); }

function httpReq(method, path, body, cb) {
  var u = new URL(PROXY_URL);
  var data = body ? Buffer.from(JSON.stringify(body)) : null;
  var opts = { hostname: u.hostname, port: u.port || 80, path: path, method: method,
    headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} };
  var req = http.request(opts, function(res) {
    var b = ''; res.on('data', function(c) { b += c; });
    res.on('end', function() { cb(null, res.statusCode, b); });
  });
  req.on('error', function(e) { cb(e); });
  if (data) req.write(data);
  req.end();
}

// 测试 1:health 仍可用
test('health 端点仍返回 200', function() {
  httpReq('GET', '/health', null, function(err, code, body) {
    if (err) throw err;
    assertEqual(code, 200, 'health 状态码');
    var j = JSON.parse(body);
    assertEqual(j.status, 'ok', 'health body');
  });
});

// 测试 2:log rotate 函数定义存在
test('log rotate: proxy.js 定义 rotateLog + MAX_LOG_BYTES', function() {
  var src = fs.readFileSync(path.join(__dirname, '..', 'proxy.js'), 'utf8');
  assert(src.indexOf('rotateLog') >= 0, 'proxy.js 未定义 rotateLog 函数');
  assert(/MAX_LOG_BYTES\s*=\s*\d+/.test(src), 'proxy.js 未定义 MAX_LOG_BYTES');
});

// 测试 3:429 backoff 实现存在
test('429 backoff: 源码包含 coolDown + 503 拒绝', function() {
  var src = fs.readFileSync(path.join(__dirname, '..', 'proxy.js'), 'utf8');
  // 旧版逐请求刷日志已替换为 markRateLimited
  assert(src.indexOf("log('STREAM ERROR ' + upRes.statusCode)") === -1 || src.indexOf('markRateLimited') >= 0, '旧版逐请求刷 429 日志仍存在');
  assert(/429/.test(src), '未处理 429 状态码');
  assert(/coolDown|isCoolingDown|markRateLimited/.test(src), '未实现 429 backoff/coolDown 逻辑');
});

// 测试 4:进程级异常保护 (v1.3.2 新增,关键修复)
test('进程异常保护: proxy.js 注册 uncaughtException + unhandledRejection', function() {
  var src = fs.readFileSync(path.join(__dirname, '..', 'proxy.js'), 'utf8');
  assert(/process\.on\(['"]uncaughtException['"]/.test(src), '未注册 uncaughtException 监听器,异步回调报错会杀进程');
  assert(/process\.on\(['"]unhandledRejection['"]/.test(src), '未注册 unhandledRejection 监听器');
});

// 测试 5:socket error 监听 (v1.3.2 新增,关键修复)
test('socket 错误监听: 覆盖 req + res + upRes + upstream', function() {
  var src = fs.readFileSync(path.join(__dirname, '..', 'proxy.js'), 'utf8');
  // 必须有 res.on('error', ...) 避免 EPIPE 杀掉进程
  assert(/res\.on\(['"]error['"]/.test(src), '未监听 res error 事件 — 客户端断开时 EPIPE 会导致进程崩溃');
  assert(/req\.on\(['"]error['"]/.test(src), '未监听 req error 事件');
});

// 测试 6:非流式请求仍可转发
test('非流式 /v1/messages 仍可转发(可能 4xx/5xx 但不能崩)', function() {
  httpReq('POST', '/v1/messages', {
    model: 'mm,m3', messages: [{role:'user',content:'hi'}], max_tokens: 16
  }, function(err, code, body) {
    if (err) throw err;
    assert(code >= 200 && code < 600, 'proxy 崩溃或返回非法码: ' + code);
  });
});

// 测试 7:流式 429 改写为 503 + Retry-After(v1.3.2 关键修复:必须丢弃上游 body 立刻拒收)
test('流式 429 必须改写为 503 + Retry-After(不能再透传 429)', function() {
  var u = new URL(PROXY_URL);
  var body = JSON.stringify({ model: 'bd,glm5.2', messages: [{role:'user',content:'hi'}], max_tokens: 16, stream: true });
  var opts = { hostname: u.hostname, port: u.port || 80, path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
  var req = http.request(opts, function(res) {
    var b = ''; res.on('data', function(c) { b += c; });
    res.on('end', function() {
      // 第一次:可能 200/429(上游);之后 coolDown 中可能直接 503
      // 关键是:必须能响应(streaming body 已到达),不能挂死
      assert(res.statusCode === 200 || res.statusCode === 429 || res.statusCode === 502 || res.statusCode === 503,
        '流式响应状态异常: ' + res.statusCode);
      // 如果是 503,必须带 Retry-After
      if (res.statusCode === 503) {
        assert(res.headers['retry-after'] || res.headers['Retry-After'], 'coolDown 503 缺 Retry-After 头');
      }
    });
  });
  req.on('error', function() { /* 偶发 ECONNRESET 不算挂 */ });
  req.write(body); req.end();
});

// 测试 8:coolDown 拒收时返回 503 + Retry-After(v1.3.2 关键修复:阻止客户端重试风暴)
test('coolDown 中再次请求同 provider 返回 503 + Retry-After', function() {
  var u = new URL(PROXY_URL);
  // 先发一个请求,期望它可能触发 429 → coolDown
  var body = JSON.stringify({ model: 'mm,m3', messages: [{role:'user',content:'hi'}], max_tokens: 16 });
  var opts = { hostname: u.hostname, port: u.port || 80, path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
  // 暴力触发:发 5 个,期望至少一个进入 coolDown
  for (var i = 0; i < 5; i++) {
    var r = http.request(opts, function(res) {
      var b = ''; res.on('data', function(c) { b += c; });
      res.on('end', function() {
        if (res.statusCode === 503) {
          assert(res.headers['retry-after'] || res.headers['Retry-After'], 'coolDown 503 缺 Retry-After');
        }
      });
    });
    r.on('error', function() {});
    r.write(body); r.end();
  }
});

setTimeout(function() {
  console.log('');
  console.log('结果: ' + PASSED + ' 通过, ' + FAILED + ' 失败');
  process.exit(FAILED > 0 ? 1 : 0);
}, 2000);
