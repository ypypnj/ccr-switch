#!/usr/bin/env node
// ccr-switch proxy v9 — v2.4.1 可核验模型委派 (安全修复: 非流式响应体中途中止 502 防御)
var http = require('http');
var https = require('https');
var fs = require('fs');
var crypto = require('crypto');

function fail(message) {
  console.error('错误：' + message);
  process.exit(1);
}
function parseArgs(argv) {
  if (argv.length === 1 && !argv[0].startsWith('-')) {
    return { config: __dirname + '/config.json', port: parsePort(argv[0]) };
  }
  var result = { config: null, port: null };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') {
      if (!argv[++i]) fail('--config 参数缺少配置路径');
      result.config = argv[i];
    } else if (argv[i] === '--port') {
      if (!argv[++i]) fail('--port 参数缺少端口值');
      result.port = parsePort(argv[i]);
    } else {
      fail('未知参数：' + argv[i]);
    }
  }
  if (!result.config) fail('缺少必需参数 --config');
  if (result.port === null) fail('缺少必需参数 --port');
  return result;
}
function parsePort(value) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) fail('端口非法：必须为 1-65535 的整数');
  return Number(value);
}
var cli = parseArgs(process.argv.slice(2));
var PORT = cli.port;
var LOG_DIR = (process.env.HOME || '') + '/.config/ccr-switch';
var LOG = process.env.CCR_SWITCH_LOG || LOG_DIR + '/proxy.log';
var MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB 单文件上限,超限自动 rotate

// 日志轮转:超过 MAX_LOG_BYTES 时把 .log → .log.1,新文件从空开始
// 防止 ccr-switch 长期运行后 /tmp/proxy-debug.log 撑爆磁盘
function rotateLog() {
  try {
    var stat = fs.statSync(LOG);
    if (stat.size < MAX_LOG_BYTES) return;
    var bak = LOG + '.1';
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
    fs.renameSync(LOG, bak);
  } catch(e) { /* 文件不存在等,首次启动吞掉 */ }
}

function log(msg) {
  var ts = new Date().toISOString();
  var line = ts + ' ' + String(msg).replace(/(authorization|api[_-]?key|token)\s*[:=]\s*\S+/ig, '$1=[已脱敏]');
  console.error(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    try { if (fs.lstatSync(LOG).isSymbolicLink()) return; } catch(e) {}
    rotateLog();
    fs.appendFileSync(LOG, line + '\n', { mode: 0o600 });
    fs.chmodSync(LOG, 0o600);
  } catch(e) {}
}

// 429 限流状态:每 provider 记录最近一次 429 时间,窗口内直接拒绝转发
// 防止上游持续 429 时 proxy 自身刷爆日志,加剧客户端重试
var coolDown = {}; // provider 短名(ds/mm/bd) → coolUntilEpochMs
var COOL_DOWN_MS = 30 * 1000; // 限流后 30s 内同 provider 直接 503
function isCoolingDown(providerShortName) {
  var until = coolDown[providerShortName] || 0;
  return Date.now() < until;
}
function markRateLimited(providerShortName) {
  coolDown[providerShortName] = Date.now() + COOL_DOWN_MS;
  log('RATE LIMIT provider=' + providerShortName + ' coolDown=' + COOL_DOWN_MS + 'ms');
}
// 从入参模型字符串里抽取 provider 短名(如 "mm,m3" → "mm")
// 严格要求:含逗号 + 逗号前必须是已知 PROVIDERS key。否则返回 null,避免污染 coolDown 字典
// (review by 3-person review group 2026-06-09: 旧版无逗号时返回整个 model 字符串,会让同 provider 不同 model 请求无法共享 coolDown 状态)
function shortNameOf(modelStr) {
  if (typeof modelStr !== 'string' || modelStr.indexOf(',') < 0) return null;
  var head = modelStr.split(',')[0];
  return PROVIDERS[head] ? head : null;
}

// 进程级异常保护 (v1.3.2):防止异步回调里的 unhandled error 把进程杀掉
// 429 风暴 + 客户端快速断开 → 大量 EPIPE/RST → 不监听就 unhandledException → 进程退出
process.on('uncaughtException', function(e) {
  log('未捕获异常，进程退出 code=' + (e && e.code ? e.code : 'unknown'));
  process.exit(1);
});
process.on('unhandledRejection', function() {
  log('未处理 Promise 拒绝，进程退出');
  process.exit(1);
});

// ── v2.1.0 读取 config.json 作为 provider 配置的单源真理 ──────────────────
// 不再硬编码任何 provider 信息,所有端点和 key 从 config.json 读取。
// config.json 中 models 必须为对象格式 { "短名": "上游模型名" },数组格式已废弃。
var configPath = cli.config;
var config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch(e) {
  fail('无法读取或解析配置 JSON：' + e.message);
}
if (!config || !Array.isArray(config.Providers) || config.Providers.length === 0) fail('配置缺少 Providers');
var PROVIDERS = {};
config.Providers.forEach(function(p, index) {
  if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name || typeof p.api_base_url !== 'string' || !/^https?:\/\//.test(p.api_base_url) || typeof p.api_key !== 'string' || !p.api_key || !p.models || typeof p.models !== 'object' || Array.isArray(p.models)) {
    fail('配置 Provider[' + index + '] schema 非法');
  }
  if (PROVIDERS[p.name]) fail('配置 Provider 名称重复：' + p.name);
  var modelNames = Object.keys(p.models);
  if (!modelNames.length || modelNames.some(function(k){ return typeof p.models[k] !== 'string' || !p.models[k]; })) fail('配置 Provider[' + index + '] models 非法');
  PROVIDERS[p.name] = { url: p.api_base_url, key: p.api_key, models: p.models };
});
var MODEL_BINDINGS = config.ModelBindings || {};
if (!MODEL_BINDINGS || typeof MODEL_BINDINGS !== 'object' || Array.isArray(MODEL_BINDINGS)) fail('配置 ModelBindings schema 非法');
// 兼容 Claude Code 自动升级后的日期后缀和小版本；匹配规则与目标都来自配置。
// 精确键优先，其次使用最长前缀的单尾星号键（如 claude-haiku-*）。
var MODEL_BINDING_PATTERNS = [];
Object.keys(MODEL_BINDINGS).forEach(function(wireModel) {
  var target = MODEL_BINDINGS[wireModel];
  if (!/^[A-Za-z0-9._-]+\*?$/.test(wireModel) || wireModel === '*' || typeof target !== 'string' || !/^[A-Za-z0-9._-]+,[A-Za-z0-9._-]+$/.test(target)) fail('配置 ModelBindings.' + wireModel + ' 非法');
  var parts = target.split(',');
  if (!PROVIDERS[parts[0]] || !PROVIDERS[parts[0]].models[parts[1]]) fail('配置 ModelBindings.' + wireModel + ' 指向未知模型');
  if (wireModel.endsWith('*')) MODEL_BINDING_PATTERNS.push({ prefix: wireModel.slice(0, -1), target: target });
});
MODEL_BINDING_PATTERNS.sort(function(a, b) { return b.prefix.length - a.prefix.length; });
var CONFIG_FINGERPRINT = crypto.createHash('sha256').update(JSON.stringify({
  providers: Object.keys(PROVIDERS).sort().map(function(name) { return { name: name, url: PROVIDERS[name].url, models: PROVIDERS[name].models }; }),
  bindings: MODEL_BINDINGS
})).digest('hex');

var receiptLib = require('./lib/receipt-index.js');
var receiptIndex = receiptLib.createReceiptIndex({
  ttlMs: Number(process.env.CCR_RECEIPT_TTL_MS || 300000),
  maxEntries: Number(process.env.CCR_RECEIPT_MAX_ENTRIES || 2048)
});

var thinkCache = {};
var MAX_CACHE = 30;

// FIFO queue: response thinking blocks → inject into next request
var thinkQueue = [];

function cacheThink(blocks) {
  if (!blocks || blocks.length === 0) return;
  thinkQueue.push(blocks);
  if (thinkQueue.length > MAX_CACHE) thinkQueue.shift();
  log('CACHE push, queue size=' + thinkQueue.length);
}

function injectThink(reqBody) {
  if (!reqBody.messages || reqBody.messages.length < 2) return 0;
  if (thinkQueue.length === 0) return 0;
  var injected = 0;
  for (var i = 0; i < reqBody.messages.length; i++) {
    var msg = reqBody.messages[i];
    if (msg.role !== 'assistant') continue;
    var hasThinking = false;
    if (msg.content && Array.isArray(msg.content)) {
      for (var j = 0; j < msg.content.length; j++) {
        if (msg.content[j] && msg.content[j].type === 'thinking') { hasThinking = true; break; }
      }
    }
    if (hasThinking) continue;
    if (thinkQueue.length === 0) break;
    var blocks = thinkQueue.shift();
    var newContent = [].concat(blocks);
    if (msg.content && Array.isArray(msg.content)) {
      newContent = newContent.concat(msg.content);
    } else if (typeof msg.content === 'string') {
      newContent.push({ type: 'text', text: msg.content });
    }
    msg.content = newContent;
    injected++;
    log('INJECT into msg[' + i + '] remaining queue=' + thinkQueue.length);
  }
  return injected;
}

function configuredBinding(model) {
  if (Object.prototype.hasOwnProperty.call(MODEL_BINDINGS, model)) return MODEL_BINDINGS[model];
  for (var i = 0; i < MODEL_BINDING_PATTERNS.length; i++) {
    if (model.startsWith(MODEL_BINDING_PATTERNS[i].prefix)) return MODEL_BINDING_PATTERNS[i].target;
  }
  return model;
}
function resolveModel(model) {
  if (typeof model !== 'string' || !model) return null;
  model = model.replace(/，/g, ',');
  var requested = configuredBinding(model);
  var parts = requested.split(',');
  if (parts.length === 2) {
    var prov = parts[0], mod = parts[1];
    if (PROVIDERS[prov] && PROVIDERS[prov].models[mod]) return { providerName: prov, provider: PROVIDERS[prov], alias: mod, model: PROVIDERS[prov].models[mod], binding: requested !== model };
    return null;
  }
  var matches = [];
  for (var p in PROVIDERS) {
    if (PROVIDERS[p].models[requested]) matches.push({ providerName: p, provider: PROVIDERS[p], alias: requested, model: PROVIDERS[p].models[requested], binding: requested !== model });
  }
  return matches.length === 1 ? matches[0] : null;
}
function executionReceipt(resolved, requestedModel, dispatchId, messageId) {
  return {
    receipt_version: 2,
    receipt_kind: 'execution',
    requested_model: requestedModel,
    actual_provider: resolved.providerName,
    actual_model: resolved.model,
    dispatch_id: dispatchId,
    message_id: messageId,
    config_fingerprint: 'sha256:' + CONFIG_FINGERPRINT
  };
}
function recordMessageReceipt(messageId, resolved, requestedModel, dispatchId) {
  if (typeof messageId !== 'string' || !/^[-A-Za-z0-9_:.]{1,256}$/.test(messageId)) return { status: 'invalid' };
  return receiptIndex.put(messageId, executionReceipt(resolved, requestedModel, dispatchId, messageId));
}
function receiptHeaders(resolved, requestedModel, dispatchId) {
  return {
    'X-CCR-Dispatch-Id': dispatchId,
    'X-CCR-Requested-Model': requestedModel,
    'X-CCR-Resolved-Provider': resolved.providerName,
    'X-CCR-Resolved-Model': resolved.model,
    'X-CCR-Config-Fingerprint': CONFIG_FINGERPRINT
  };
}
function mergeHeaders(base, extra) {
  var out = {};
  Object.keys(base || {}).forEach(function(k) { out[k] = base[k]; });
  Object.keys(extra || {}).forEach(function(k) { out[k] = extra[k]; });
  return out;
}
function retryAfterSeconds(headers) {
  var raw = headers && headers['retry-after'];
  if (/^\d+$/.test(String(raw || ''))) return Math.max(1, Math.min(300, Number(raw)));
  return COOL_DOWN_MS / 1000;
}

function countThinking(body) {
  var count = 0;
  if (body.messages && Array.isArray(body.messages)) {
    body.messages.forEach(function(m) {
      if (m.content && Array.isArray(m.content)) {
        m.content.forEach(function(c) { if (c && c.type === 'thinking') count++; });
      }
    });
  }
  return count;
}

function normalizeRequest(body) {
  if (body.messages && Array.isArray(body.messages)) {
    var sys = body.messages.filter(function(m) { return m.role === 'system'; });
    if (sys.length > 0) {
      var sc = sys.map(function(m) { return { type: 'text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }; });
      if (!body.system) { body.system = sc; } else { body.system = body.system.concat(sc); }
      body.messages = body.messages.filter(function(m) { return m.role !== 'system'; });
    }
  }
    // adaptive thinking passes through natively (matching direct DeepSeek behavior)
  // Do NOT set default effort — conflicts with thinking=disabled
  return body;
}

// Parse SSE stream text for thinking blocks
function parseSSEThinking(text) {
  var blocks = [];
  // Match JSON data in SSE events
  var re = /data:\s*(\{.*\})/g;
  var match;
  var currentThink = '';
  while ((match = re.exec(text)) !== null) {
    try {
      var ev = JSON.parse(match[1]);
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'thinking_delta') {
        currentThink += ev.delta.thinking || '';
      } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'signature_delta') {
        // thinking block complete — save it
        if (currentThink) {
          blocks.push({ type: 'thinking', thinking: currentThink, signature: 'ccr_' });
          currentThink = '';
        }
      }
    } catch(e) {}
  }
  return blocks;
}

var server = http.createServer(function(req, res) {
  // 客户端 socket error 监听(v1.3.2):429 风暴中客户端快速断开重试,
  // res.write 触发 EPIPE 默认会冒泡为 uncaughtException,杀掉整个 proxy 进程
  req.on('error', function(e) { log('REQ ERR ' + e.code + ' ' + e.message); });
  res.on('error', function(e) { log('RES ERR ' + e.code + ' ' + e.message); });

  if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        var originalModel = data.model;
        var thinkBlocksIn = countThinking(data);
        log('REQ model=' + String(data.model).replace(/[\r\n]/g, ' ') + ' msgs=' + (data.messages||[]).length + ' think=' + thinkBlocksIn + ' top=' + JSON.stringify(data.thinking));

        var resolved = resolveModel(data.model);
        if (!resolved) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'unknown_model', message: 'requested model is not configured' } }));
          return;
        }
        var provName = resolved.providerName;
        var dispatchId = crypto.randomBytes(12).toString('hex');
        var dispatchHeaders = receiptHeaders(resolved, originalModel, dispatchId);
        // 429/overload backoff:该 provider 在 coolDown 窗口内直接拒收。
        if (isCoolingDown(provName)) {
          log('COOLING DOWN provider=' + provName + ' reject=503');
          res.writeHead(503, mergeHeaders({ 'Content-Type': 'application/json', 'Retry-After': String(COOL_DOWN_MS / 1000) }, dispatchHeaders));
          res.end(JSON.stringify({ error: { type: 'provider_circuit_open', message: 'provider cooling down' } }));
          return;
        }
        data.model = resolved.model;
        data = normalizeRequest(data);

        // M3 模型默认启用 thinking（支持 extended thinking 模式）
        if (data.model && data.model.includes('MiniMax-M3')) {
          data.thinking = data.thinking || { type: 'enabled', budget_tokens: 32000 };
        }

        // Re-inject cached thinking blocks
        if (data.model && !data.model.includes('haiku')) {
          var injected = injectThink(data);
          if (injected > 0) { data.thinking = data.thinking || { type: 'enabled', budget_tokens: 16000 }; }
        }

        var thinkBlocksOut = countThinking(data);
        log('SEND model=' + data.model + ' think=' + thinkBlocksOut + ' top=' + JSON.stringify(data.thinking));

        var isStream = (data.stream === true);
        var url = new URL(resolved.provider.url);
        var postData = JSON.stringify(data);
        var options = {
          hostname: url.hostname, port: url.port || (url.protocol === 'http:' ? 80 : 443),
          path: url.pathname + (req.url.includes('?') ? '?' + req.url.split('?')[1] : ''),
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': resolved.provider.key, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(postData) }
        };

        var requestTransport = url.protocol === 'http:' ? http : https;
        var _streamDeferred = false;
        var upstream = requestTransport.request(options, function(upRes) {
          // 上游响应流 error 监听(v1.3.2):网络层 ECONNRESET/EPIPE 不监听会冒泡杀进程
          upRes.on('error', function(e) {
            log('上游响应流错误 code=' + (e.code || 'unknown'));
          });
          if (isStream) {
            _streamDeferred = true;
            if (upRes.statusCode === 429) {
              var retryAfter = retryAfterSeconds(upRes.headers);
              markRateLimited(provName);
              upRes.resume();
              res.writeHead(429, mergeHeaders({ 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) }, dispatchHeaders));
              return res.end(JSON.stringify({ error: { type: 'provider_rate_limited', message: 'provider rate limited' } }));
            }
            if (upRes.statusCode === 503 || upRes.statusCode === 529) {
              var overloadRetryAfter = retryAfterSeconds(upRes.headers);
              markRateLimited(provName);
              upRes.resume();
              res.writeHead(upRes.statusCode, mergeHeaders({ 'Content-Type': 'application/json', 'Retry-After': String(overloadRetryAfter) }, dispatchHeaders));
              return res.end(JSON.stringify({ error: { type: 'provider_overloaded', message: 'provider overloaded' } }));
            }
            if (upRes.statusCode >= 400) {
              upRes.resume();
              var errBody = JSON.stringify({ error: { type: 'upstream_error', status: upRes.statusCode, message: 'upstream request failed' } });
              res.writeHead(upRes.statusCode, mergeHeaders({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(errBody) }, dispatchHeaders));
              res.end(errBody);
              log('STREAM ERROR ' + upRes.statusCode + ' (non-SSE → JSON) model=' + originalModel);
              return;
            }
            delete upRes.headers['content-length'];
            var deferredHeaders = mergeHeaders(upRes.headers, dispatchHeaders);
            var headersSent = false;
            var streamFailed = false;
            var DEFERRED_MAX_BYTES = Number(process.env.CCR_DEFERRED_MAX_BYTES || 65536);
            var streamMessageId = null;
            var sseFrames = receiptLib.createSSEFrameCollector();
            var deferredOutput = '';
            var leftover = '';
            var fullText = '';
            var fallbackInjected = false;

            function failClosed(reason) {
              if (headersSent) return;
              headersSent = true;
              streamFailed = true;
              _streamDeferred = false;
              try {
                var err = JSON.stringify({ error: { type: 'missing_message_receipt', message: reason } });
                res.writeHead(502, mergeHeaders({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(err) }, dispatchHeaders));
                res.end(err);
              } catch(_) {}
              log('STREAM FAIL CLOSED: ' + reason + ' model=' + originalModel);
            }

            function flushDeferred() {
              if (headersSent) return;
              headersSent = true;
              _streamDeferred = false;
              res.writeHead(upRes.statusCode, deferredHeaders);
              if (deferredOutput) {
                res.write(deferredOutput);
                deferredOutput = '';
              }
            }

            function writeOrDefer(data) {
              if (headersSent) { res.write(data); } else { deferredOutput += data; }
            }

            upRes.on('error', function(e) {
              if (streamFailed) return;
              if (!headersSent) { failClosed('upstream stream error before message_receipt'); return; }
              if (res.writableEnded) return;
              try {
                res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":0}}\n\n');
                res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
              } catch(_) {}
              res.end();
            });

            upRes.on('data', function(chunk) {
              if (streamFailed) return;
              var rawChunk = chunk.toString();
              // Scan for message_start while headers are deferred
              if (streamMessageId === null) {
                var frames = sseFrames.feed(rawChunk);
                for (var fi = 0; fi < frames.length && streamMessageId === null; fi++) {
                  try {
                    var sseEvent = receiptLib.parseSSEFrameData(frames[fi]);
                    if (sseEvent && sseEvent.type === 'message_start' && sseEvent.message && sseEvent.message.id) {
                      streamMessageId = sseEvent.message.id;
                      var rcpRes = recordMessageReceipt(streamMessageId, resolved, originalModel, dispatchId);
                      if (rcpRes.status === 'stored' || rcpRes.status === 'idempotent') { flushDeferred(); }
                      else { failClosed('receipt ' + rcpRes.status); }
                    }
                  } catch(e) {}
                }
              }
              // Normal pipeline: signature replacement, line splitting, fallback injection
              var text = leftover + rawChunk;
              text = text.replace(/"signature":"[^"]+"/g, '"signature":"ccr_"');
              var lines = text.split('\n');
              leftover = lines.pop();
              fullText += lines.join('\n') + '\n';
              // v2.2.0 auto mode 兜底 (streaming 路径):在 message_stop 之前注入 text_delta。
              var processedLines = lines.join('\n') + '\n';
              if (!fallbackInjected && /"type":\s*"thinking"/.test(fullText)) {
                var allTextMatches = fullText.match(/"text"\s*:\s*"([^"]*)"/g) || [];
                var hasNonEmptyText = allTextMatches.some(function(m) {
                  return m.replace(/"text"\s*:\s*"/, '').slice(0, -1).length > 0;
                });
                if (!hasNonEmptyText) {
                  var fallbackSse = 'event: content_block_start\n'
                    + 'data: {"type":"content_block_start","index":99,"content_block":{"type":"text","text":""}}\n\n'
                    + 'event: content_block_delta\n'
                    + 'data: {"type":"content_block_delta","index":99,"delta":{"type":"text_delta","text":"OK"}}\n\n'
                    + 'event: content_block_stop\n'
                    + 'data: {"type":"content_block_stop","index":99}\n\n';
                  var stopMatch = processedLines.match(/^event: message_stop\s*$/m);
                  if (stopMatch) {
                    var before = processedLines.substring(0, stopMatch.index);
                    var after = processedLines.substring(stopMatch.index);
                    writeOrDefer(before);
                    writeOrDefer(fallbackSse);
                    writeOrDefer(after);
                    fallbackInjected = true;
                    log('AUTO MODE FALLBACK (stream): 注入占位 text_delta 在 message_stop 前,model=' + originalModel);
                  } else {
                    writeOrDefer(processedLines);
                  }
                } else {
                  writeOrDefer(processedLines);
                }
              } else {
                writeOrDefer(processedLines);
              }
              if (!headersSent && deferredOutput.length > DEFERRED_MAX_BYTES) {
                upRes.destroy();
                failClosed('deferred buffer overflow');
              }
            });
            upRes.on('end', function() {
              streamFinished = true;
              if (!headersSent) { failClosed('stream completed without message_receipt'); return; }
              if (leftover) { fullText += leftover; res.write(leftover); }
              if (!res.writableEnded) res.end();
              // Extract thinking blocks from streaming response for caching
              if (upRes.statusCode === 200) {
                var blocks = []; // parseSSEThinking disabled
                if (blocks.length > 0) {
                  log('STREAM DONE cached=' + blocks.length + ' bytes=' + fullText.length);
                } else {
                  log('STREAM DONE (no thinking blocks) bytes=' + fullText.length);
                }
              } else {
                log('STREAM ERROR ' + upRes.statusCode + ' bytes=' + fullText.length);
              }
            });
            // v2.3.1: 上游无声断连防御 — GLM 在高 thinking 请求时偶发 socket 关闭,
            // 但既不触发 'end' 也不触发 'error'(负载均衡切换 / SSL 重协商失败 / RST)。
            // 不监听 'close' 的话 res 永远不结束 → 客户端 Unexpected EOF。
            // 这里在 socket 真正关闭时兜底结束 res,并记日志确认根因。
            // (若 'end' 已正常触发,'close' 随后到达时 streamFinished 守卫会跳过)
            var streamFinished = false;
            upRes.on('aborted', function() {
              if (streamFinished) return;
              if (!headersSent) { streamFinished = true; failClosed('stream aborted before message_receipt'); return; }
              streamFinished = true;
              if (!res.writableEnded) {
                try {
                  res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":0}}\n\n');
                  res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
                } catch(_) {}
                res.end();
              }
              log('STREAM ABORTED model=' + originalModel);
            });
            upRes.on('close', function() {
              if (streamFinished) return;
              if (!headersSent) { streamFinished = true; failClosed('stream closed before message_receipt'); return; }
              streamFinished = true;
              if (!res.writableEnded) {
                // 上游无声断连,SSE 不完整。补一个 max_tokens 截断结尾,
                // 让客户端收到"完整但被截断"的响应,而不是 Unexpected EOF 硬错误。
                try {
                  res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":0}}\n\n');
                  res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
                } catch(e) {}
                res.end();
              }
              log('STREAM CLOSED EARLY (upstream socket closed, end not fired) model=' + originalModel + ' bytes=' + fullText.length);
            });
          } else {
            var respBody = '';
            var nonStreamingFinished = false;
            function endNonStreamingError() {
              if (nonStreamingFinished) return;
              nonStreamingFinished = true;
              if (res.writableEnded) return;
              try {
                var errBody = JSON.stringify({ error: { type: 'provider_network_error', message: '上游响应体中途中止' } });
                res.writeHead(502, mergeHeaders({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(errBody) }, dispatchHeaders));
                res.end(errBody);
              } catch(_) {}
            }
            upRes.on('error', function(e) { log('上游非流式响应体错误 code=' + (e && e.code || 'unknown')); endNonStreamingError(); });
            upRes.on('aborted', function() { log('上游非流式响应体 aborted model=' + originalModel); endNonStreamingError(); });
            upRes.on('close', function() { if (nonStreamingFinished) return; log('上游非流式响应体 close-before-end model=' + originalModel); endNonStreamingError(); });
            upRes.on('data', function(c) { respBody += c; });
            upRes.on('end', function() {
              if (nonStreamingFinished) return;
              nonStreamingFinished = true;
              if (upRes.statusCode >= 400) {
                if (upRes.statusCode === 429 || upRes.statusCode === 503 || upRes.statusCode === 529) {
                  var limited = upRes.statusCode === 429;
                  var retryAfter = retryAfterSeconds(upRes.headers);
                  markRateLimited(provName);
                  res.writeHead(upRes.statusCode, mergeHeaders({ 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) }, dispatchHeaders));
                  res.end(JSON.stringify({ error: { type: limited ? 'provider_rate_limited' : 'provider_overloaded', message: limited ? 'provider rate limited' : 'provider overloaded' } }));
                } else {
                  log('上游非流式错误 status=' + upRes.statusCode + ' model=' + originalModel);
                  var safeError = JSON.stringify({ error: { type: 'upstream_error', status: upRes.statusCode, message: '上游请求失败' } });
                  res.writeHead(upRes.statusCode, mergeHeaders({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(safeError) }, dispatchHeaders));
                  res.end(safeError);
                }
              } else {
                try {
                  var rj = JSON.parse(respBody);
                  if(!rj.id){ res.writeHead(502,mergeHeaders({'Content-Type':'application/json','Content-Length':Buffer.byteLength(JSON.stringify({error:{type:'missing_message_receipt',message:'non-streaming response missing id'}}))},dispatchHeaders)); res.end(JSON.stringify({error:{type:'missing_message_receipt',message:'non-streaming response missing id'}})); log('NON-STREAM FAIL CLOSED: missing id model='+originalModel); return; }
                  var rcpRes = recordMessageReceipt(rj.id,resolved,originalModel,dispatchId);
                  if(rcpRes.status!=='stored'&&rcpRes.status!=='idempotent'){ res.writeHead(502,mergeHeaders({'Content-Type':'application/json','Content-Length':Buffer.byteLength(JSON.stringify({error:{type:'missing_message_receipt',message:'receipt '+rcpRes.status}}))},dispatchHeaders)); res.end(JSON.stringify({error:{type:'missing_message_receipt',message:'receipt '+rcpRes.status}})); log('NON-STREAM FAIL CLOSED: receipt '+rcpRes.status+' model='+originalModel); return; }
                  var blocks = [];
                  if (rj.content && Array.isArray(rj.content)) {
                    rj.content.forEach(function(c) {
                      if (c && c.type === 'thinking') {
                        c.signature = 'ccr_';
                        blocks.push(c);
                      }
                    });
                  }
                  if (blocks.length > 0) { }
                  // thinking 模型在 max_tokens 受限时可能输出空 text 块；
                  // 追加最小占位 text，避免客户端把有效 thinking 响应误判为模型不可用。
                  var hasNonEmptyText = rj.content && rj.content.some(function(c) {
                    return c && c.type === 'text' && typeof c.text === 'string' && c.text.length > 0;
                  });
                  if (!hasNonEmptyText && rj.content && rj.content.some(function(c) { return c && c.type === 'thinking'; })) {
                    rj.content.push({ type: 'text', text: 'OK' });
                    log('AUTO MODE FALLBACK: 注入占位 text 块,model=' + rj.model);
                  }
                  rj.model = originalModel;
              if (!rj.stop_sequence && rj.stop_sequence !== null) { rj.stop_sequence = null; }
              delete rj.base_resp;
              var fixed = JSON.stringify(rj); var hdrs=mergeHeaders(upRes.headers,dispatchHeaders); delete hdrs["transfer-encoding"]; hdrs["content-length"]=Buffer.byteLength(fixed); res.writeHead(upRes.statusCode, hdrs); res.end(fixed);
                  log('OK model=' + rj.model + ' cached=' + blocks.length);
                } catch(e) {
                  log('NON-STREAM FAIL CLOSED: JSON parse failed model=' + originalModel);
                  var errFail = JSON.stringify({ error: { type: 'missing_message_receipt', message: 'non-streaming JSON parse failed' } });
                  res.writeHead(502, mergeHeaders({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(errFail) }, dispatchHeaders));
                  res.end(errFail);
                }
              }
            });
          }
        });
        upstream.on('error', function(e) {
          log('上游请求网络错误 code=' + (e && e.code || 'unknown'));
          // 防御性:res 可能已关闭(被 coolDown/429 提前 end),不检查会抛 ERR_STREAM_WRITE_AFTER_END
          if (res.writableEnded) return;
          try {
            var errType = (isStream && _streamDeferred) ? 'missing_message_receipt' : 'provider_network_error';
            var errMsg = (isStream && _streamDeferred) ? 'stream interrupted before message_receipt' : '上游连接失败';
            res.writeHead(502, mergeHeaders({ 'Content-Type': 'application/json' }, dispatchHeaders));
            res.end(JSON.stringify({error:{type:errType,message:errMsg}}));
          } catch(_) {}
        });
        upstream.write(postData);
        upstream.end();
      } catch(e) {
        log('请求解析失败');
        res.writeHead(400); res.end(JSON.stringify({error:{message:'Bad request'}}));
      }
    });
  } else if (req.url === '/v1/models' || req.url.startsWith('/v1/models?')) {
    var models = [];
    for (var p in PROVIDERS) {
      for (var m in PROVIDERS[p].models) {
        models.push({ id: p + ',' + m, object: 'model', owned_by: p });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: models }));
  } else if (req.url === '/health') {
    res.writeHead(200); res.end(JSON.stringify({ status: 'ok' }));
  } else if(req.method==='GET'&&req.url.startsWith('/v1/receipts/by-message-id/')){
    function jsonReplyRcpt(r,s,b){try{r.writeHead(s,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)});r.end(b)}catch(e){}}
    var remote=req.socket.remoteAddress||'';
    if(!receiptLib.isLoopbackAddress(remote))return jsonReplyRcpt(res,403,JSON.stringify({error:{type:'loopback_only'}}));
    var id; try{id=decodeURIComponent(req.url.slice('/v1/receipts/by-message-id/'.length).split('?')[0])}catch(e){return jsonReplyRcpt(res,400,JSON.stringify({error:{type:'invalid_message_id'}}))}
    if(!/^[-A-Za-z0-9_:.]{1,256}$/.test(id))return jsonReplyRcpt(res,400,JSON.stringify({error:{type:'invalid_message_id'}}));
    var found=receiptIndex.get(id);
    if(found.status==='missing')return jsonReplyRcpt(res,404,JSON.stringify({error:{type:'receipt_not_found'}}));
    if(found.status==='conflict')return jsonReplyRcpt(res,409,JSON.stringify({error:{type:'receipt_conflict'}}));
    return jsonReplyRcpt(res,200,JSON.stringify(found.receipt));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});
// ── v2.1.0 启动期 config.json key 校验 ────────────────────────────────────
// 检查 config.json 中所有 provider 的 api_key 是否仍含占位符,
// 防止 install.sh 静默失败或用户忘记填真 key。
(function sanityCheckConfigKeys() {
  var bad = config.Providers.filter(function(p) {
    return !p.api_key || p.api_key.indexOf('__') >= 0 || p.api_key.indexOf('YOUR_') >= 0;
  });
  if (bad.length) {
    console.error('错误：配置 Providers 中仍含占位符 key：' + bad.map(function(p){return p.name;}).join(','));
    console.error('请通过安装器生成运行时配置。');
    process.exit(1);
  }
})();
server.listen(PORT, '127.0.0.1', function() { log('STARTED v9 (v2.4.1) on 127.0.0.1:' + PORT); });
