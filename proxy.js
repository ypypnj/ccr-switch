#!/usr/bin/env node
// ccr-switch proxy v5 — streaming thinking block caching
var http = require('http');
var https = require('https');
var fs = require('fs');
var crypto = require('crypto');
var PORT = process.argv[2] || 3456;
var LOG = '/tmp/proxy-debug.log';
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
  var line = ts + ' ' + msg;
  console.error(line);
  try { rotateLog(); fs.appendFileSync(LOG, line + '\n'); } catch(e) {}
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
  log('UNCAUGHT ' + (e && e.code ? e.code : '') + ' ' + (e && e.message ? e.message : String(e)));
});
process.on('unhandledRejection', function(reason) {
  log('UNHANDLED REJECTION ' + (reason && reason.message ? reason.message : String(reason)));
});

// provider 配置:每加一个 provider,在 PROVIDERS 加一条,
// models 字典的 key 是用户传的短名(provider,short),value 是上游完整模型名
// ccr-switch v1.3.0 新增 bd (Baidu Qianfan) provider
// v1.3.0 安全改造:真 key 不再硬编码,使用占位符 __MM_KEY__ / __BD_KEY__ / __DS_KEY__,运行时由 install.sh 替换为 ~/.claude/dev-flow/credentials.json 中的真 key
var PROVIDERS = {
  ds: { url: 'https://api.deepseek.com/anthropic/v1/messages', key: '__DS_KEY__', models: { v4pro: 'deepseek-v4-pro', v4flash: 'deepseek-v4-flash', 'claude-sonnet-4-6': 'deepseek-v4-pro', 'claude-opus-4-8': 'deepseek-v4-pro', 'claude-haiku-4-5': 'deepseek-v4-flash' } },
  mm: { url: 'https://api.minimaxi.com/anthropic/v1/messages', key: '__MM_KEY__', models: { 'm3': 'MiniMax-M3' } },
  bd: { url: 'https://qianfan.baidubce.com/anthropic/coding/v1/messages', key: '__BD_KEY__', models: { 'glm5.1': 'glm-5.1' } }
};

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

function resolveModel(model) { model = (model || "v4pro").replace(/，/g, ","); model = (model || 'v4pro').replace(/\uff0c/g, ',');
  var parts = (model || 'v4pro').split(',');
  if (parts.length === 2) {
    var prov = parts[0], mod = parts[1];
    if (PROVIDERS[prov] && PROVIDERS[prov].models[mod]) return { provider: PROVIDERS[prov], model: PROVIDERS[prov].models[mod] };
  }
  for (var p in PROVIDERS) {
    if (PROVIDERS[p].models[model]) return { provider: PROVIDERS[p], model: PROVIDERS[p].models[model] };
  }
  return { provider: PROVIDERS.ds, model: PROVIDERS.ds.models.v4pro };
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
        var provName = shortNameOf(data.model) || 'unknown';
        // 429 backoff (v1.3.2):该 provider 在 coolDown 窗口内,直接 503 拒收
        // 减少上游 429 时的重试风暴,降低客户端断开概率
        if (isCoolingDown(provName)) {
          log('COOLING DOWN provider=' + provName + ' reject=503');
          res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(COOL_DOWN_MS / 1000) });
          res.end(JSON.stringify({ error: { type: 'rate_limit', message: 'provider cooling down, retry in ' + (COOL_DOWN_MS/1000) + 's' } }));
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
          hostname: url.hostname, port: url.port || 443,
          path: url.pathname + (req.url.includes('?') ? '?' + req.url.split('?')[1] : ''),
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': resolved.provider.key, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(postData) }
        };

        var upstream = https.request(options, function(upRes) {
          // 上游响应流 error 监听(v1.3.2):网络层 ECONNRESET/EPIPE 不监听会冒泡杀进程
          upRes.on('error', function(e) { log('UPRES ERR ' + e.code + ' ' + e.message); });
          if (isStream) {
            // 429 必须立刻改写为 503 + Retry-After 拒收(不能再透传 upRes.statusCode=429,
            // 否则客户端会立刻重试,coolDown 窗口形同虚设)
            if (upRes.statusCode === 429) {
              markRateLimited(provName);
              upRes.resume(); // 丢弃上游 body,防止 socket 悬挂
              res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(COOL_DOWN_MS / 1000) });
              return res.end(JSON.stringify({ error: { type: 'rate_limit', message: 'provider 429, coolDown ' + (COOL_DOWN_MS/1000) + 's' } }));
            }
            delete upRes.headers['content-length'];
            res.writeHead(upRes.statusCode, upRes.headers);
            var leftover = '';
            var fullText = '';
            upRes.on('data', function(chunk) {
              var text = leftover + chunk.toString();
              text = text.replace(/"signature":"[^"]+"/g, '"signature":"ccr_"');
              var lines = text.split('\n');
              leftover = lines.pop();
              fullText += lines.join('\n') + '\n';
              res.write(lines.join('\n') + '\n');
            });
            upRes.on('end', function() {
              if (leftover) { fullText += leftover; res.write(leftover); }
              res.end();
              // Extract thinking blocks from streaming response for caching
              if (upRes.statusCode === 200) {
                var blocks = []; // parseSSEThinking disabled
                if (blocks.length > 0) {
                  log('STREAM DONE cached=' + blocks.length);
                } else {
                  log('STREAM DONE (no thinking blocks)');
                }
              } else {
                log('STREAM ERROR ' + upRes.statusCode);
              }
            });
          } else {
            var respBody = '';
            upRes.on('data', function(c) { respBody += c; });
            upRes.on('end', function() {
              if (upRes.statusCode >= 400) {
                if (upRes.statusCode === 429) {
                  // 429 单次记 RATE LIMIT 后进入 coolDown,向客户端返回 503(v1.3.2)
                  markRateLimited(provName);
                  res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '30' });
                  res.end(JSON.stringify({ error: { type: 'rate_limit', message: 'provider 429, coolDown 30s' } }));
                } else {
                  log('ERROR ' + upRes.statusCode + ' ' + respBody.substring(0, 300));
                  res.writeHead(upRes.statusCode, upRes.headers);
                  res.end(respBody);
                }
              } else {
                try {
                  var rj = JSON.parse(respBody);
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
                  rj.model = originalModel;
              if (!rj.stop_sequence && rj.stop_sequence !== null) { rj.stop_sequence = null; }
              delete rj.base_resp;
              var fixed = JSON.stringify(rj); var hdrs={}; Object.keys(upRes.headers).forEach(function(k){hdrs[k]=upRes.headers[k]}); hdrs["content-length"]=Buffer.byteLength(fixed); res.writeHead(upRes.statusCode, hdrs); res.end(fixed);
                  log('OK model=' + rj.model + ' cached=' + blocks.length);
                } catch(e) {
                  log('OK (raw pipe)');
                  res.writeHead(upRes.statusCode, upRes.headers);
                  res.end(respBody);
                }
              }
            });
          }
        });
        upstream.on('error', function(e) {
          log('NET ERROR ' + (e && e.code || '') + ' ' + e.message);
          // 防御性:res 可能已关闭(被 coolDown/429 提前 end),不检查会抛 ERR_STREAM_WRITE_AFTER_END
          if (res.writableEnded) return;
          try { res.writeHead(502); res.end(JSON.stringify({error:{message:e.message}})); } catch(_) {}
        });
        upstream.write(postData);
        upstream.end();
      } catch(e) {
        log('PARSE ERROR ' + e.message);
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
  } else {
    res.writeHead(404); res.end('Not found');
  }
});
// 启动期占位符检查 (v1.3.3):阻止占位符 key 启动,防止 install.sh 静默失败
// 动态拼接匹配串,避免守卫代码在源文件里自引用字面量
(function sanityCheckPlaceholder() {
  var src = require('fs').readFileSync(__filename, 'utf8');
  var bad = ['DS','MM','BD'].filter(function(p) { return src.indexOf('__' + p + '_KEY__') >= 0; });
  if (bad.length) {
    console.error('FATAL proxy.js 仍含占位符 ' + bad.join(',') + ',install.sh 未运行或 sed 替换失败。退出 1 拒绝启动。');
    process.exit(1);
  }
})();
server.listen(PORT, '127.0.0.1', function() { log('STARTED v5 on 127.0.0.1:' + PORT); });
