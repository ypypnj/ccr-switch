#!/usr/bin/env node
// ccr-switch proxy v5 — streaming thinking block caching
var http = require('http');
var https = require('https');
var fs = require('fs');
var crypto = require('crypto');
var PORT = process.argv[2] || 3456;
var LOG = '/tmp/proxy-debug.log';

function log(msg) {
  var ts = new Date().toISOString();
  var line = ts + ' ' + msg;
  console.error(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch(e) {}
}

var PROVIDERS = {
  ds: { url: 'https://api.deepseek.com/anthropic/v1/messages', key: '__DS_KEY_REDACTED__', models: { v4pro: 'deepseek-v4-pro', v4flash: 'deepseek-v4-flash' } },
  mm: { url: 'https://api.minimaxi.com/anthropic/v1/messages', key: '__MM_KEY_REDACTED__', models: { 'm2.7': 'MiniMax-M2.7' } }
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

function resolveModel(model) {
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
  var m = body.model || '';
  if (m.includes("haiku")) {
    delete body.thinking; delete body.reasoning;
    if (body.messages && Array.isArray(body.messages)) {
      body.messages = body.messages.map(function(msg) {
        var clean = {};
        Object.keys(msg).forEach(function(k) { if (k !== 'thinking' && k !== 'reasoning_content') { clean[k] = msg[k]; } });
        if (clean.content && Array.isArray(clean.content)) {
          clean.content = clean.content.filter(function(c) { return c && c.type !== 'thinking'; });
        }
        return clean;
      });
    }
  } else if (body.thinking && body.thinking.type === 'adaptive') {
    body.thinking = { type: 'enabled', budget_tokens: 16000 };
  }
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
  if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        var thinkBlocksIn = countThinking(data);
        log('REQ model=' + data.model + ' msgs=' + (data.messages||[]).length + ' think=' + thinkBlocksIn + ' top=' + JSON.stringify(data.thinking));

        var resolved = resolveModel(data.model);
        data.model = resolved.model;
        data = normalizeRequest(data);

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
          if (isStream) {
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
                var blocks = parseSSEThinking(fullText);
                if (blocks.length > 0) {
                  cacheThink(blocks);
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
                log('ERROR ' + upRes.statusCode + ' ' + respBody.substring(0, 300));
                res.writeHead(upRes.statusCode, upRes.headers);
                res.end(respBody);
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
                  if (blocks.length > 0) { cacheThink(blocks); }
                  var fixed = JSON.stringify(rj);
                  res.writeHead(upRes.statusCode, upRes.headers);
                  res.end(fixed);
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
        upstream.on('error', function(e) { log('NET ERROR ' + e.message); res.writeHead(502); res.end(JSON.stringify({error:{message:e.message}})); });
        upstream.write(postData);
        upstream.end();
      } catch(e) {
        log('PARSE ERROR ' + e.message);
        res.writeHead(400); res.end(JSON.stringify({error:{message:'Bad request'}}));
      }
    });
  } else if (req.url === '/health') {
    res.writeHead(200); res.end(JSON.stringify({ status: 'ok' }));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});
server.listen(PORT, '127.0.0.1', function() { log('STARTED v5 on 127.0.0.1:' + PORT); });
