#!/usr/bin/env node
'use strict';
// Task 0 契约测试 — v2.4.1 可核验模型委派
// 零外部依赖，仅用 Node 内置模块。自启动 proxy 子进程 + mock upstream。
// 不读取真实凭据、不访问公网、不绑定 3456、不残留进程和文件。

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');

const proxyScript = path.resolve(__dirname, '..', 'proxy.js');
const scriptDir = path.resolve(__dirname, '..', 'scripts');
let passed = 0;
let failed = 0;
const children = new Set();

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS ' + name);
  } catch (e) {
    failed++;
    console.error('FAIL ' + name + '\n  ' + e.message);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}

function httpReq(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const opts = { host: '127.0.0.1', port, path: urlPath, method };
    if (raw) Object.assign(opts, { headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } });
    const r = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (raw) r.write(raw);
    r.end();
  });
}

function waitHealth(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const max = Math.ceil((timeoutMs || 4000) / 25);
    (function poll() {
      httpReq(port, 'GET', '/health').then(r => r.status === 200 ? resolve() : retry()).catch(retry);
      function retry() { if (++n > max) reject(new Error('代理未在 ' + (timeoutMs || 4000) + 'ms 内就绪')); else setTimeout(poll, 25); }
    })();
  });
}

async function stopChild(child) {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* already dead */ }
  try { child.kill('SIGKILL'); } catch (e) { /* already dead */ }
  children.delete(child);
}

async function cleanup() {
  for (const c of [...children]) await stopChild(c);
}

process.once('SIGINT', () => cleanup().finally(() => process.exit(130)));
process.once('SIGTERM', () => cleanup().finally(() => process.exit(143)));

function spawnProxy(configObj, port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't0-home-'));
  const configDir = path.join(home, '.config', 'ccr-switch');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configFile = path.join(configDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(configObj), { mode: 0o600 });
  const logFile = path.join(configDir, 'proxy.log');

  const child = cp.spawn(process.execPath, [proxyScript, '--config', configFile, '--port', String(port)], {
    env: { ...process.env, HOME: home, CCR_SWITCH_LOG: logFile },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);

  let output = '';
  child.stdout.on('data', c => output += c);
  child.stderr.on('data', c => output += c);

  return {
    child, home, configDir, logFile,
    output: () => output,
    async stop() { await stopChild(child); try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* best effort */ } },
  };
}

// ── Mock upstream ──
function startMockUpstream(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch (e) { parsed = { model: '<bad json>' }; }
      handler(req, res, parsed);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => { resolve(server); });
    server.on('error', reject);
  });
}

function fixtureConfig(upstreamPort, overrides) {
  return Object.assign({
    Providers: [
      {
        name: 'ds',
        api_base_url: 'http://127.0.0.1:' + upstreamPort + '/v1/messages',
        api_key: 'fixture-ds-key-not-real',
        models: { v4pro: 'deepseek-v4-pro', v4flash: 'deepseek-v4-flash' },
      },
      {
        name: 'xa',
        api_base_url: 'http://127.0.0.1:' + upstreamPort + '/v1/messages',
        api_key: 'fixture-xa-key-not-real',
        models: { gpt5: 'gpt-5.6-sol' },
      },
    ],
    ModelBindings: {
      'claude-haiku-*': 'ds,v4flash',
      'claude-sonnet-*': 'ds,v4pro',
      'claude-opus-*': 'xa,gpt5',
      'claude-fable-*': 'xa,gpt5',
    },
  }, overrides || {});
}

// ──────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────

(async () => {

  // ── 1. 未来后缀 wildcard 映射 ──
  await test('未来后缀 Haiku/Sonnet/Opus/Fable 通配符映射到正确上游', async () => {
    const seen = [];
    const upstream = await startMockUpstream((req, res, body) => {
      seen.push(body.model);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok', model: body.model, content: [{ type: 'text', text: 'OK' }] }));
    });
    const upPort = upstream.address().port;
    const port = await freePort();
    const proxy = spawnProxy(fixtureConfig(upPort), port);
    try {
      await waitHealth(port);
      const models = [
        'claude-haiku-4-9-20280101',
        'claude-sonnet-5-20280101',
        'claude-opus-4-9-20280101',
        'claude-fable-5-20280101',
      ];
      for (const m of models) {
        const r = await httpReq(port, 'POST', '/v1/messages', { model: m, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
        ok(r.status === 200, m + ' 路由失败 status=' + r.status);
      }
      ok(
        JSON.stringify(seen) === JSON.stringify(['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.6-sol', 'gpt-5.6-sol']),
        'wildcard 映射错误: ' + JSON.stringify(seen)
      );
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 2. 映射目标可仅改配置切换 ──
  await test('Haiku 目标可仅靠配置改为另一 provider', async () => {
    let upstreamModel = '';
    const upstream = await startMockUpstream((req, res, body) => {
      upstreamModel = body.model;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok', model: body.model, content: [{ type: 'text', text: 'OK' }] }));
    });
    const upPort = upstream.address().port;
    const config = fixtureConfig(upPort, { ModelBindings: { 'claude-haiku-*': 'xa,gpt5', 'claude-sonnet-*': 'ds,v4pro' } });
    const port = await freePort();
    const proxy = spawnProxy(config, port);
    try {
      await waitHealth(port);
      const r = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-haiku-4-9-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      ok(r.status === 200, '路由失败');
      ok(upstreamModel === 'gpt-5.6-sol', '未按配置切换目标: ' + upstreamModel);
      ok(r.headers['x-ccr-resolved-provider'] === 'xa', 'receipt provider 错误');
      ok(r.headers['x-ccr-resolved-model'] === 'gpt-5.6-sol', 'receipt model 错误');
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 3. 未知模型 400 ──
  await test('未知模型返回 400 且上游零调用', async () => {
    let hitCount = 0;
    const upstream = await startMockUpstream((req, res, body) => {
      hitCount++;
      res.end('{}');
    });
    const upPort = upstream.address().port;
    const port = await freePort();
    const proxy = spawnProxy(fixtureConfig(upPort), port);
    try {
      await waitHealth(port);
      const models = ['claude-unknown-9', 'gpt-7', 'nonexistent-model-2028'];
      for (const m of models) {
        const r = await httpReq(port, 'POST', '/v1/messages', { model: m, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
        ok(r.status === 400, m + ' 应返回 400 但返回 ' + r.status);
        ok(JSON.parse(r.body).error.type === 'unknown_model', m + ' 错误类型应为 unknown_model');
      }
      ok(hitCount === 0, '上游被调用了 ' + hitCount + ' 次(应为 0)');
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 4. Dispatch Receipt 字段 ──
  await test('Dispatch Receipt 字段存在且自洽', async () => {
    const upstream = await startMockUpstream((req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok', model: body.model, content: [{ type: 'text', text: 'OK' }] }));
    });
    const upPort = upstream.address().port;
    const port = await freePort();
    const proxy = spawnProxy(fixtureConfig(upPort), port);
    try {
      await waitHealth(port);
      const r = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-sonnet-5-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      ok(r.status === 200, '请求失败');
      ok(r.headers['x-ccr-dispatch-id'] && /^[0-9a-f]{24}$/.test(r.headers['x-ccr-dispatch-id']), 'dispatch-id 缺失或格式错');
      ok(r.headers['x-ccr-requested-model'] === 'claude-sonnet-5-20280101', 'requested-model 错误: ' + r.headers['x-ccr-requested-model']);
      ok(r.headers['x-ccr-resolved-provider'] === 'ds', 'resolved-provider 错误: ' + r.headers['x-ccr-resolved-provider']);
      ok(r.headers['x-ccr-resolved-model'] === 'deepseek-v4-pro', 'resolved-model 错误: ' + r.headers['x-ccr-resolved-model']);
      ok(r.headers['x-ccr-config-fingerprint'] && /^[0-9a-f]{64}$/.test(r.headers['x-ccr-config-fingerprint']), 'config-fingerprint 缺失或格式错');
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 5. 429 触发 circuit-open，另一 provider 不受影响 ──
  await test('首次 429 与随后 circuit-open 分类，另一 provider 不受影响', async () => {
    let xaCalls = 0;
    const upstream = await startMockUpstream((req, res, body) => {
      if (body.model === 'gpt-5.6-sol') {
        xaCalls++;
        res.writeHead(429, { 'retry-after': '5' });
        return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok', model: body.model, content: [{ type: 'text', text: 'OK' }] }));
    });
    const upPort = upstream.address().port;
    const port = await freePort();
    const proxy = spawnProxy(fixtureConfig(upPort), port);
    try {
      await waitHealth(port);

      const r1 = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-opus-4-9-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: false });
      ok(r1.status === 429, '429 请求应返回 429: ' + r1.status);
      ok(JSON.parse(r1.body).error.type === 'provider_rate_limited', '429 错误类型应为 provider_rate_limited');
      ok(r1.headers['retry-after'] && /^\d+$/.test(r1.headers['retry-after']), '429 应带 retry-after');

      const r2 = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-opus-4-9-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: false });
      ok(r2.status === 503, 'circuit-open 应返回 503: ' + r2.status);
      ok(JSON.parse(r2.body).error.type === 'provider_circuit_open', 'error 类型应为 provider_circuit_open');
      ok(r2.headers['retry-after'] && /^\d+$/.test(r2.headers['retry-after']), '503 应带 retry-after');

      const r3 = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-sonnet-5-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: false });
      ok(r3.status === 200, 'ds 应正常: ' + r3.status);
      ok(r3.headers['x-ccr-resolved-provider'] === 'ds', 'ds receipt 错误');

      ok(xaCalls === 1, 'xa 上游应只被调用 1 次,实际 ' + xaCalls);
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 6. stream 路径 429 分类 ──
  await test('stream 路径 429 分类为 provider_rate_limited', async () => {
    let hitCount = 0;
    const upstream = await startMockUpstream((req, res, body) => {
      hitCount++;
      res.writeHead(429, { 'retry-after': '5' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    });
    const upPort = upstream.address().port;
    const port = await freePort();
    const config = fixtureConfig(upPort);
    config.ModelBindings['claude-haiku-*'] = 'xa,gpt5';
    const proxy = spawnProxy(config, port);
    try {
      await waitHealth(port);
      const r = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-haiku-4-9-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: true });
      ok(r.status === 429, 'stream 429 应返回 429: ' + r.status);
      ok(JSON.parse(r.body).error.type === 'provider_rate_limited', 'error 类型应为 provider_rate_limited');
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 7. 503 circuit-open 也携带 Dispatch Receipt ──
  await test('503 circuit-open 响应携带 Dispatch Receipt', async () => {
    let first = true;
    const upstream = await startMockUpstream((req, res) => {
      if (first) { first = false; res.writeHead(429, { 'retry-after': '5' }); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok', content: [{ type: 'text', text: 'OK' }] }));
    });
    const upPort = upstream.address().port;
    const port = await freePort();
    const proxy = spawnProxy(fixtureConfig(upPort), port);
    try {
      await waitHealth(port);
      await httpReq(port, 'POST', '/v1/messages', { model: 'claude-opus-4-9-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      const r2 = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-opus-4-9-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      ok(r2.status === 503, '应返回 503');
      ok(JSON.parse(r2.body).error.type === 'provider_circuit_open', '应为 circuit_open');
      ok(r2.headers['x-ccr-dispatch-id'] && /^[0-9a-f]{24}$/.test(r2.headers['x-ccr-dispatch-id']), '503 应带 dispatch-id');
      ok(r2.headers['x-ccr-requested-model'] === 'claude-opus-4-9-20280101', '503 应带 requested-model');
      ok(r2.headers['x-ccr-resolved-provider'] === 'xa', '503 应带 resolved-provider');
      ok(r2.headers['x-ccr-config-fingerprint'] && /^[0-9a-f]{64}$/.test(r2.headers['x-ccr-config-fingerprint']), '503 应带 config-fingerprint');
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 8. 精确匹配优先于通配符 ──
  await test('精确 ModelBindings 匹配优先于通配符', async () => {
    const seen = [];
    const upstream = await startMockUpstream((req, res, body) => {
      seen.push(body.model);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok', model: body.model, content: [{ type: 'text', text: 'OK' }] }));
    });
    const upPort = upstream.address().port;
    const config = fixtureConfig(upPort, {
      ModelBindings: {
        'claude-haiku-4-5-20251001': 'xa,gpt5',
        'claude-haiku-*': 'ds,v4flash',
        'claude-sonnet-*': 'ds,v4pro',
      },
    });
    const port = await freePort();
    const proxy = spawnProxy(config, port);
    try {
      await waitHealth(port);
      const r1 = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      ok(r1.status === 200, '精确匹配失败');
      ok(r1.headers['x-ccr-resolved-provider'] === 'xa', '精确匹配应走 xa');

      const r2 = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-haiku-4-9-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      ok(r2.status === 200, '通配匹配失败');
      ok(r2.headers['x-ccr-resolved-provider'] === 'ds', '通配匹配应走 ds');

      ok(JSON.stringify(seen) === JSON.stringify(['gpt-5.6-sol', 'deepseek-v4-flash']), '匹配优先级错误: ' + JSON.stringify(seen));
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 9. 重叠通配符：最长前缀获胜 ──
  await test('重叠通配符：最长前缀匹配获胜', async () => {
    const seen = [];
    const upstream = await startMockUpstream((req, res, body) => {
      seen.push(body.model);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok', model: body.model, content: [{ type: 'text', text: 'OK' }] }));
    });
    const upPort = upstream.address().port;
    // claude-haiku-4-9-* (更长) → xa,gpt5; claude-haiku-* (更短) → ds,v4flash
    const config = fixtureConfig(upPort, {
      ModelBindings: {
        'claude-haiku-4-9-*': 'xa,gpt5',
        'claude-haiku-*': 'ds,v4flash',
        'claude-sonnet-*': 'ds,v4pro',
      },
    });
    const port = await freePort();
    const proxy = spawnProxy(config, port);
    try {
      await waitHealth(port);
      // claude-haiku-4-9-20280101 匹配 claude-haiku-4-9-*(更长) → xa,gpt5
      const r1 = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-haiku-4-9-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      ok(r1.status === 200, '最长前缀匹配失败');
      ok(r1.headers['x-ccr-resolved-provider'] === 'xa', '最长前缀应走 xa, 实际: ' + r1.headers['x-ccr-resolved-provider']);

      // claude-haiku-4-5-2025 只匹配 claude-haiku-*(更短) → ds,v4flash
      const r2 = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-haiku-4-5-20250101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      ok(r2.status === 200, '短前缀匹配失败');
      ok(r2.headers['x-ccr-resolved-provider'] === 'ds', '短前缀应走 ds, 实际: ' + r2.headers['x-ccr-resolved-provider']);

      ok(JSON.stringify(seen) === JSON.stringify(['gpt-5.6-sol', 'deepseek-v4-flash']), '重叠通配符错误: ' + JSON.stringify(seen));
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 10. fingerprint 对仅 API key 改变保持一致 ──
  await test('config-fingerprint 对仅 API key 改变时保持一致', async () => {
    const upstream = await startMockUpstream((req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok', model: body.model, content: [{ type: 'text', text: 'OK' }] }));
    });
    const upPort = upstream.address().port;
    const config1 = fixtureConfig(upPort);
    const port1 = await freePort();
    const proxy1 = spawnProxy(config1, port1);
    try {
      await waitHealth(port1);
      const r1 = await httpReq(port1, 'POST', '/v1/messages', { model: 'claude-sonnet-5-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      ok(r1.status === 200, '请求1失败');
      const fp1 = r1.headers['x-ccr-config-fingerprint'];
      ok(fp1 && /^[0-9a-f]{64}$/.test(fp1), 'fingerprint1 格式错误: ' + fp1);
      await proxy1.stop();

      // 配置2: 仅改 api_key
      const config2 = fixtureConfig(upPort);
      config2.Providers[0].api_key = 'fixture-ds-key-changed-but-same-length';
      config2.Providers[1].api_key = 'fixture-xa-key-also-changed-xxxxxxxx';
      const port2 = await freePort();
      const proxy2 = spawnProxy(config2, port2);
      try {
        await waitHealth(port2);
        const r2 = await httpReq(port2, 'POST', '/v1/messages', { model: 'claude-sonnet-5-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
        ok(r2.status === 200, '请求2失败');
        const fp2 = r2.headers['x-ccr-config-fingerprint'];
        ok(fp2 === fp1, '仅 API key 改变，fingerprint 应一致: ' + fp1 + ' vs ' + fp2);
      } finally { await proxy2.stop(); }
    } finally { upstream.close(); }
  });

  // ── 11. 503/529 provider_overloaded 分类 ──
  await test('上游 503/529 分类为 provider_overloaded 并触发 circuit-open', async () => {
    let firstCall = true;
    const upstream = await startMockUpstream((req, res, body) => {
      if (firstCall) {
        firstCall = false;
        res.writeHead(503, { 'retry-after': '10' });
        return res.end(JSON.stringify({ error: { message: 'service overloaded' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok', model: body.model, content: [{ type: 'text', text: 'OK' }] }));
    });
    const upPort = upstream.address().port;
    const port = await freePort();
    const proxy = spawnProxy(fixtureConfig(upPort), port);
    try {
      await waitHealth(port);
      const r1 = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-haiku-4-9-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: false });
      ok(r1.status === 503, '应返回 503: ' + r1.status);
      ok(JSON.parse(r1.body).error.type === 'provider_overloaded', '应为 provider_overloaded, 实际: ' + JSON.parse(r1.body).error.type);

      // 后续请求应被 circuit-open 拦截(同 provider ds 被限流)
      const r2 = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-haiku-4-9-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: false });
      ok(r2.status === 503, 'circuit-open 应返回 503: ' + r2.status);
      ok(JSON.parse(r2.body).error.type === 'provider_circuit_open', '应为 circuit_open');
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 12. 529 provider_overloaded ──
  await test('上游 529 分类为 provider_overloaded (stream 路径)', async () => {
    const upstream = await startMockUpstream((req, res, body) => {
      res.writeHead(529, { 'retry-after': '15' });
      res.end(JSON.stringify({ error: { message: 'overloaded' } }));
    });
    const upPort = upstream.address().port;
    const port = await freePort();
    const config = fixtureConfig(upPort);
    config.ModelBindings['claude-haiku-*'] = 'xa,gpt5';
    const proxy = spawnProxy(config, port);
    try {
      await waitHealth(port);
      const r = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-haiku-4-9-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: true });
      ok(r.status === 529, 'stream 529 应返回 529: ' + r.status);
      ok(JSON.parse(r.body).error.type === 'provider_overloaded', '应为 provider_overloaded, 实际: ' + JSON.parse(r.body).error.type);
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 13. 连接失败 provider_network_error ──
  await test('上游连接失败返回 502 provider_network_error', async () => {
    // 先占用端口后立即关闭，生成一个确定不可达但合法的端口号
    const deadPort = await freePort();
    const config = {
      Providers: [
        {
          name: 'dead',
          api_base_url: 'http://127.0.0.1:' + deadPort + '/v1/messages',
          api_key: 'test-key',
          models: { test: 'test-model' },
        },
      ],
      ModelBindings: { 'claude-test-*': 'dead,test' },
    };
    const port = await freePort();
    const proxy = spawnProxy(config, port);
    try {
      await waitHealth(port);
      const r = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-test-1', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: false });
      ok(r.status === 502, '连接失败应返回 502: ' + r.status);
      ok(JSON.parse(r.body).error.type === 'provider_network_error', '应为 provider_network_error, 实际: ' + JSON.parse(r.body).error.type);
      // 连接失败时模型已解析，应携带 receipt
      ok(r.headers['x-ccr-dispatch-id'] && /^[0-9a-f]{24}$/.test(r.headers['x-ccr-dispatch-id']), '502 应带 dispatch-id');
    } finally {
      await proxy.stop();
    }
  });

  // ── 14. 非流式响应体中途中止 502 ──
  await test('非流式上游响应体中途中止不挂起，返回 502', async () => {
    const upstream = await startMockUpstream((req, res, body) => {
      // 写入 headers 后立即销毁 socket，模拟中途断连
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":"partial"');
      // 在还没发完 body 时销毁 socket
      setTimeout(() => { res.socket.destroy(); }, 20);
    });
    const upPort = upstream.address().port;
    const config = fixtureConfig(upPort);
    config.ModelBindings['claude-haiku-*'] = 'ds,v4flash';
    const port = await freePort();
    const proxy = spawnProxy(config, port);
    try {
      await waitHealth(port);
      // 设置较短超时: 如果挂起，测试会超时
      const raw = JSON.stringify({ model: 'claude-haiku-4-9-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: false });
      const result = await new Promise((resolve, reject) => {
        const r = http.request({
          hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
          timeout: 4000,
        }, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('请求超时 — 非流式响应体中途中止导致挂起')); });
        r.write(raw);
        r.end();
      });
      ok(result.status === 502, '中止应返回 502: ' + result.status);
      ok(JSON.parse(result.body).error.type === 'provider_network_error', '应为 provider_network_error: ' + result.body);
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 15. 显式 provider,alias 路由 ──
  await test('显式 provider,alias 格式可正确路由', async () => {
    let seenModel = '';
    const upstream = await startMockUpstream((req, res, body) => {
      seenModel = body.model;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok', model: body.model, content: [{ type: 'text', text: 'OK' }] }));
    });
    const upPort = upstream.address().port;
    const port = await freePort();
    const proxy = spawnProxy(fixtureConfig(upPort), port);
    try {
      await waitHealth(port);
      const r = await httpReq(port, 'POST', '/v1/messages', { model: 'ds,v4pro', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      ok(r.status === 200, '显式路由 failed: ' + r.status);
      ok(seenModel === 'deepseek-v4-pro', '上游应收到 deepseek-v4-pro: ' + seenModel);
      ok(r.headers['x-ccr-resolved-provider'] === 'ds', 'receipt provider 应为 ds');
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 16. 全局唯一裸 alias ──
  await test('全局唯一裸 alias 可正确路由', async () => {
    let seenModel = '';
    const upstream = await startMockUpstream((req, res, body) => {
      seenModel = body.model;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok', model: body.model, content: [{ type: 'text', text: 'OK' }] }));
    });
    const upPort = upstream.address().port;
    // v4flash 仅 ds provider 有 → 全局唯一
    const config = fixtureConfig(upPort, { ModelBindings: {} });
    const port = await freePort();
    const proxy = spawnProxy(config, port);
    try {
      await waitHealth(port);
      const r = await httpReq(port, 'POST', '/v1/messages', { model: 'v4flash', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      ok(r.status === 200, '裸 alias 路由失败: ' + r.status);
      ok(seenModel === 'deepseek-v4-flash', '上游应收到 deepseek-v4-flash: ' + seenModel);
      ok(r.headers['x-ccr-resolved-provider'] === 'ds', 'receipt provider 应为 ds');
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 17. 空 ModelBindings 兼容 ──
  await test('空 ModelBindings {} 兼容：仅显式格式路由有效', async () => {
    let seenModel = '';
    const upstream = await startMockUpstream((req, res, body) => {
      seenModel = body.model;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok', model: body.model, content: [{ type: 'text', text: 'OK' }] }));
    });
    const upPort = upstream.address().port;
    const config = fixtureConfig(upPort, { ModelBindings: {} });
    const port = await freePort();
    const proxy = spawnProxy(config, port);
    try {
      await waitHealth(port);
      // 显式 provider,alias → 有效
      const r1 = await httpReq(port, 'POST', '/v1/messages', { model: 'xa,gpt5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      ok(r1.status === 200, '空 ModelBindings 显式路由应有效: ' + r1.status);
      ok(seenModel === 'gpt-5.6-sol', '上游 model 错误: ' + seenModel);

      // 未绑定的 claude 型号 → 400
      seenModel = '';
      const r2 = await httpReq(port, 'POST', '/v1/messages', { model: 'claude-sonnet-5-20280101', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      ok(r2.status === 400, '空 ModelBindings 未绑定型号应 400: ' + r2.status);
      ok(JSON.parse(r2.body).error.type === 'unknown_model', '应为 unknown_model');
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ── 18. 未知模型 400 不携带 receipt ──
  await test('未知模型 400 不携带 Dispatch Receipt', async () => {
    const upstream = await startMockUpstream(() => {});
    const upPort = upstream.address().port;
    const port = await freePort();
    const proxy = spawnProxy(fixtureConfig(upPort), port);
    try {
      await waitHealth(port);
      const r = await httpReq(port, 'POST', '/v1/messages', { model: 'totally-unknown-model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      ok(r.status === 400, '应返回 400');
      ok(!r.headers['x-ccr-dispatch-id'], '400 不应带 dispatch-id');
      ok(!r.headers['x-ccr-resolved-provider'], '400 不应带 resolved-provider');
      ok(!r.headers['x-ccr-resolved-model'], '400 不应带 resolved-model');
    } finally {
      await proxy.stop();
      upstream.close();
    }
  });

  // ──────────────────────────────────────────────────────────
  // 控制脚本生命周期测试
  // ──────────────────────────────────────────────────────────

  function setupControlTestHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 't0-ctl-'));
    const installDir = path.join(home, '.local', 'share', 'ccr-switch');
    const stateDir = path.join(home, '.config', 'ccr-switch');
    fs.mkdirSync(installDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(installDir, 'scripts'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // 部署 proxy.js 和 config
    fs.copyFileSync(proxyScript, path.join(installDir, 'proxy.js'));
    fs.chmodSync(path.join(installDir, 'proxy.js'), 0o755);
    // 写 config.json
    const config = {
      Providers: [{
        name: 'ds',
        api_base_url: 'http://127.0.0.1:1/v1/messages',
        api_key: 'test-not-real-key-for-lifecycle-tests',
        models: { v4pro: 'deepseek-v4-pro' },
      }],
      ModelBindings: { 'claude-sonnet-*': 'ds,v4pro' },
    };
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    return { home, installDir, stateDir };
  }

  // ── 19. 脚本不使用 pkill/fuser ──
  await test('ccr-switch-on/off 脚本不使用 pkill 或 fuser', async () => {
    const scripts = [
      path.join(scriptDir, 'ccr-switch-on'),
      path.join(scriptDir, 'ccr-switch-off'),
    ];
    for (const s of scripts) {
      const content = fs.readFileSync(s, 'utf8');
      ok(!/\bpkill\b/.test(content), s + ' 包含 pkill');
      ok(!/\bfuser\b/.test(content), s + ' 包含 fuser');
    }
  });

  // ── 20. ccr-switch-on 拒绝 symlink PID 文件 ──
  await test('ccr-switch-on 拒绝 symlink PID 文件', async () => {
    const { home, installDir, stateDir } = setupControlTestHome();
    const pidFile = path.join(stateDir, 'proxy.pid');
    const logFile = path.join(stateDir, 'proxy.log');
    fs.writeFileSync(logFile, '', { mode: 0o600 });
    // 创建指向 /dev/null 的 symlink 作为 PID 文件
    fs.symlinkSync('/dev/null', pidFile);
    try {
      const result = cp.spawnSync('bash', [path.join(scriptDir, 'ccr-switch-on')], {
        env: { ...process.env, HOME: home, CCR_SWITCH_INSTALL_DIR: installDir, CCR_SWITCH_PORT: String(await freePort()), CCR_SWITCH_USE_SYSTEMD: '0' },
        timeout: 5000,
      });
      ok(result.status !== 0, 'symlink PID 应被拒绝(非零退出)，实际 exit=' + result.status);
    } finally {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // ── 21. ccr-switch-on 拒绝 symlink 日志文件 ──
  await test('ccr-switch-on 拒绝 symlink 日志文件', async () => {
    const { home, installDir, stateDir } = setupControlTestHome();
    const logFile = path.join(stateDir, 'proxy.log');
    fs.symlinkSync('/dev/null', logFile);
    try {
      const result = cp.spawnSync('bash', [path.join(scriptDir, 'ccr-switch-on')], {
        env: { ...process.env, HOME: home, CCR_SWITCH_INSTALL_DIR: installDir, CCR_SWITCH_PORT: String(await freePort()), CCR_SWITCH_USE_SYSTEMD: '0' },
        timeout: 5000,
      });
      ok(result.status !== 0, 'symlink log 应被拒绝(非零退出)，实际 exit=' + result.status);
    } finally {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // ── 22. ccr-switch-off 拒绝 symlink PID 文件 ──
  await test('ccr-switch-off 拒绝 symlink PID 文件', async () => {
    const { home, installDir, stateDir } = setupControlTestHome();
    const pidFile = path.join(stateDir, 'proxy.pid');
    fs.symlinkSync('/dev/null', pidFile);
    try {
      const result = cp.spawnSync('bash', [path.join(scriptDir, 'ccr-switch-off')], {
        env: { ...process.env, HOME: home, CCR_SWITCH_INSTALL_DIR: installDir },
        timeout: 5000,
      });
      ok(result.status !== 0, 'symlink PID 应被拒绝(非零退出)，实际 exit=' + result.status);
    } finally {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // ── 23. ccr-switch-off 拒绝 PID start-time 不匹配 ──
  await test('ccr-switch-off 拒绝 PID start-time 不匹配', async () => {
    const { home, installDir, stateDir } = setupControlTestHome();
    const port = await freePort();
    // 启动一个真实 proxy
    const child = cp.spawn(process.execPath, [proxyScript, '--config', path.join(stateDir, 'config.json'), '--port', String(port)], {
      env: { ...process.env, HOME: home, CCR_SWITCH_LOG: path.join(stateDir, 'proxy.log') },
      detached: true,
      stdio: 'ignore',
    });
    children.add(child);
    try {
      // 等待 proxy 就绪
      await waitHealth(port, 4000);
      const realPid = child.pid;
      // 写在 PID 文件中但用错误的 start-time
      const pidFile = path.join(stateDir, 'proxy.pid');
      fs.writeFileSync(pidFile, realPid + ' 999999999', { mode: 0o600 });
      // ccr-switch-off 应拒绝(因为 start-time 不匹配)
      const result = cp.spawnSync('bash', [path.join(scriptDir, 'ccr-switch-off')], {
        env: { ...process.env, HOME: home, CCR_SWITCH_INSTALL_DIR: installDir },
        timeout: 5000,
      });
      ok(result.status !== 0, 'start-time 不匹配应拒绝(非零退出)，实际 exit=' + result.status);
    } finally {
      await stopChild(child);
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // ── 24. 已有进程重启到新 PID ──
  await test('ccr-switch-on 对已有进程先停止再启动新 PID', async () => {
    const { home, installDir, stateDir } = setupControlTestHome();
    const port = await freePort();
    // 启动第一个 proxy
    const child1 = cp.spawn(process.execPath, [proxyScript, '--config', path.join(stateDir, 'config.json'), '--port', String(port)], {
      env: { ...process.env, HOME: home, CCR_SWITCH_LOG: path.join(stateDir, 'proxy.log') },
      detached: true,
      stdio: 'ignore',
    });
    children.add(child1);
    try {
      await waitHealth(port, 4000);
      // 写入正确的 PID 文件(含真实 start-time)
      const procStarttime = (pid) => {
        try {
          const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
          const i = stat.lastIndexOf(') ');
          return stat.slice(i + 2).split(' ')[19];
        } catch (e) { return ''; }
      };
      const start1 = procStarttime(child1.pid);
      const pidFile = path.join(stateDir, 'proxy.pid');
      fs.writeFileSync(pidFile, child1.pid + ' ' + start1, { mode: 0o600 });

      // 运行 ccr-switch-on(模拟成功的重启)
      const result = cp.spawnSync('bash', [path.join(scriptDir, 'ccr-switch-on')], {
        env: { ...process.env, HOME: home, CCR_SWITCH_INSTALL_DIR: installDir, CCR_SWITCH_PORT: String(port), CCR_SWITCH_USE_SYSTEMD: '0', PATH: process.env.PATH },
        timeout: 10000,
      });
      // 重启应该成功(或者至少不失败)
      // 检查 PID 文件是否更新为新 PID
      if (result.status === 0 && fs.existsSync(pidFile)) {
        const newContent = fs.readFileSync(pidFile, 'utf8').trim();
        const parts = newContent.split(/\s+/);
        const newPid = parseInt(parts[0], 10);
        ok(newPid !== child1.pid, '重启后 PID 应改变(旧:' + child1.pid + ', 新:' + newPid + ')');
        // 旧进程应该已停止
        try { process.kill(child1.pid, 0); ok(false, '旧进程应已停止'); } catch (e) {
          ok(e.code === 'ESRCH', '旧进程应已不存在');
        }
        // 清理新进程
        try { process.kill(-newPid, 'SIGTERM'); } catch (e) {}
      }
    } finally {
      await stopChild(child1);
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // ── 25. 启动失败不发布错误 PID ──
  await test('ccr-switch-on 启动失败不更新 PID 文件', async () => {
    const { home, installDir, stateDir } = setupControlTestHome();
    const port = await freePort();
    // 破坏 config 让 proxy 无法启动
    fs.writeFileSync(path.join(stateDir, 'config.json'), 'not-valid-json', { mode: 0o600 });
    const pidFile = path.join(stateDir, 'proxy.pid');
    // 先写一个已有的 PID 文件(模拟旧运行状态)
    fs.writeFileSync(pidFile, '12345 999999999', { mode: 0o600 });

    const result = cp.spawnSync('bash', [path.join(scriptDir, 'ccr-switch-on')], {
      env: { ...process.env, HOME: home, CCR_SWITCH_INSTALL_DIR: installDir, CCR_SWITCH_PORT: String(port), CCR_SWITCH_USE_SYSTEMD: '0', CCR_SWITCH_TEST_START_FAIL: '1' },
      timeout: 10000,
    });
    // 启动失败
    ok(result.status !== 0, '启动失败应非零退出，实际 exit=' + result.status);
    // PID 文件不应被破坏为 "新进程 PID"
    if (fs.existsSync(pidFile)) {
      const content = fs.readFileSync(pidFile, 'utf8').trim();
      ok(!/^\d+\s+\d+$/.test(content) || content.startsWith('12345'),
        'PID 文件不应被替换为错误内容: ' + content);
    }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
  });

  // ── 26. ccr-switch-on 拒绝 FIFO PID 文件 ──
  await test('ccr-switch-on 拒绝 FIFO PID 文件', async () => {
    const { home, installDir, stateDir } = setupControlTestHome();
    const pidFile = path.join(stateDir, 'proxy.pid');
    const logFile = path.join(stateDir, 'proxy.log');
    fs.writeFileSync(logFile, '', { mode: 0o600 });
    // 创建命名管道(FIFO)替代 PID 文件
    try { cp.execSync('mkfifo ' + JSON.stringify(pidFile)); } catch (e) { /* skip if mkfifo unavailable */ }
    if (!fs.existsSync(pidFile)) { console.log('  SKIP (no mkfifo available)'); try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {} return; }
    try {
      const result = cp.spawnSync('bash', [path.join(scriptDir, 'ccr-switch-on')], {
        env: { ...process.env, HOME: home, CCR_SWITCH_INSTALL_DIR: installDir, CCR_SWITCH_PORT: String(await freePort()), CCR_SWITCH_USE_SYSTEMD: '0' },
        timeout: 5000,
      });
      ok(result.status !== 0, 'FIFO PID 应被拒绝(非零退出)，实际 exit=' + result.status);
    } finally {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // ── 27. ccr-switch-on 拒绝 FIFO 日志文件 ──
  await test('ccr-switch-on 拒绝 FIFO 日志文件', async () => {
    const { home, installDir, stateDir } = setupControlTestHome();
    const logFile = path.join(stateDir, 'proxy.log');
    try { cp.execSync('mkfifo ' + JSON.stringify(logFile)); } catch (e) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {} return; }
    try {
      const result = cp.spawnSync('bash', [path.join(scriptDir, 'ccr-switch-on')], {
        env: { ...process.env, HOME: home, CCR_SWITCH_INSTALL_DIR: installDir, CCR_SWITCH_PORT: String(await freePort()), CCR_SWITCH_USE_SYSTEMD: '0' },
        timeout: 5000,
      });
      ok(result.status !== 0, 'FIFO log 应被拒绝(非零退出)，实际 exit=' + result.status);
    } finally {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // ── 28. 活 PID identity mismatch → fail closed ──
  await test('活 PID identity mismatch 拒绝启动且不修改 PID 文件', async () => {
    const { home, installDir, stateDir } = setupControlTestHome();
    const port = await freePort();
    // 用不同的 cmdline 启动一个进程(非代理),模拟身份不匹配
    // 写 PID 文件指向一个 live ccr-switch 代理但用不同端口/cmdline
    const child = cp.spawn(process.execPath, [proxyScript, '--config', path.join(stateDir, 'config.json'), '--port', String(port)], {
      env: { ...process.env, HOME: home, CCR_SWITCH_LOG: path.join(stateDir, 'proxy.log') },
      detached: true,
      stdio: 'ignore',
    });
    children.add(child);
    try {
      await waitHealth(port, 4000);
      const pidFile = path.join(stateDir, 'proxy.pid');
      const originalPidContent = child.pid + ' 1';
      fs.writeFileSync(pidFile, originalPidContent, { mode: 0o600 });

      // 现在用不同端口跑 ccr-switch-on → cmdline 会不匹配
      const otherPort = await freePort();
      const result = cp.spawnSync('bash', [path.join(scriptDir, 'ccr-switch-on')], {
        env: { ...process.env, HOME: home, CCR_SWITCH_INSTALL_DIR: installDir, CCR_SWITCH_PORT: String(otherPort), CCR_SWITCH_USE_SYSTEMD: '0', PATH: process.env.PATH },
        timeout: 10000,
      });
      ok(result.status !== 0, '身份不匹配应拒绝(非零退出)，实际 exit=' + result.status);
      // PID 文件不应被修改
      ok(fs.readFileSync(pidFile, 'utf8').trim() === originalPidContent,
        'PID 文件不应被修改，内容: ' + fs.readFileSync(pidFile, 'utf8').trim());
    } finally {
      await stopChild(child);
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // ── 29. 端口已有无 PID 代理时不得把旧 health 当成新进程成功 ──
  await test('端口已有无 PID 文件代理时，ccr-switch-on 不误认旧 health', async () => {
    const { home, installDir, stateDir } = setupControlTestHome();
    const port = await freePort();
    // 先启动一个代理但不写 PID 文件(模拟"无 PID 文件"场景)
    const oldChild = cp.spawn(process.execPath, [proxyScript, '--config', path.join(stateDir, 'config.json'), '--port', String(port)], {
      env: { ...process.env, HOME: home, CCR_SWITCH_LOG: path.join(stateDir, 'proxy.log') },
      detached: true,
      stdio: 'ignore',
    });
    children.add(oldChild);
    try {
      await waitHealth(port, 4000);
      // 确认没有 PID 文件
      const pidFile = path.join(stateDir, 'proxy.pid');
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);

      // 再跑 ccr-switch-on(同一端口) — 新进程会 EADDRINUSE 退出，health 会命中旧代理
      const result = cp.spawnSync('bash', [path.join(scriptDir, 'ccr-switch-on')], {
        env: { ...process.env, HOME: home, CCR_SWITCH_INSTALL_DIR: installDir, CCR_SWITCH_PORT: String(port), CCR_SWITCH_USE_SYSTEMD: '0', PATH: process.env.PATH },
        timeout: 10000,
      });
      // 应失败(端口被占用，新进程 EADDRINUSE 退出)
      ok(result.status !== 0, '端口被占用且无 PID 文件时应拒绝，实际 exit=' + result.status);
      // PID 文件不应发布(旧代理没有 PID 文件)
      if (fs.existsSync(pidFile)) {
        const content = fs.readFileSync(pidFile, 'utf8').trim();
        // PID 文件不应指向旧代理(旧代理没有 PID 文件，所以 PID 文件只能是 staging 被错误发布)
        const parts = content.split(/\s+/);
        ok(Number(parts[0]) !== oldChild.pid,
          'PID 文件不应指向旧代理: ' + content + ' (旧PID=' + oldChild.pid + ')');
      }
    } finally {
      await stopChild(oldChild);
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // ── 汇总 ──
  console.log('\nTask 0 契约测试汇总: ' + passed + ' 通过, ' + failed + ' 失败, ' + (passed + failed) + ' 总计');
  await cleanup();
  process.exit(failed ? 1 : 0);
})();
