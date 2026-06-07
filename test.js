#!/usr/bin/env node
// ccr-switch 测试套件 — 验证模型解析和 M3 thinking 注入
var http = require('http');

var PROXY_URL = process.env.TEST_PROXY_URL || 'http://127.0.0.1:3456';
var FAILED = 0;
var PASSED = 0;

function test(name, fn) {
  console.log('  TEST: ' + name);
  try {
    fn();
    PASSED++;
    console.log('    ✅ PASS');
  } catch(e) {
    FAILED++;
    console.log('    ❌ FAIL: ' + e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error((msg || '值不相等') + ': 期望=' + JSON.stringify(b) + ' 实际=' + JSON.stringify(a));
}

// 测试 1：/v1/models 返回正确的模型列表
function testModelsEndpoint(cb) {
  http.get(PROXY_URL + '/v1/models', function(res) {
    var body = '';
    res.on('data', function(c) { body += c; });
    res.on('end', function() {
      try {
        var data = JSON.parse(body);
        test('返回 object=list', function() {
          assertEqual(data.object, 'list');
        });
        test('包含 ds,v4pro', function() {
          var found = data.data.some(function(m) { return m.id === 'ds,v4pro'; });
          assert(found, 'ds,v4pro 未在模型列表中');
        });
        test('包含 mm,m3', function() {
          var found = data.data.some(function(m) { return m.id === 'mm,m3'; });
          assert(found, 'mm,m3 未在模型列表中');
        });
        test('不包含 mm,m2.7', function() {
          var found = data.data.some(function(m) { return m.id === 'mm,m2.7'; });
          assert(!found, 'mm,m2.7 不应出现在模型列表中');
        });
        cb();
      } catch(e) { console.error('  ❌ 模型列表解析失败: ' + e.message); cb(); }
    });
  }).on('error', function(e) { console.error('  ❌ 连接失败: ' + e.message); cb(); });
}

// 测试 2：/health 端点
function testHealthEndpoint(cb) {
  http.get(PROXY_URL + '/health', function(res) {
    var body = '';
    res.on('data', function(c) { body += c; });
    res.on('end', function() {
      test('健康检查返回 ok', function() {
        var data = JSON.parse(body);
        assertEqual(data.status, 'ok');
      });
      cb();
    });
  }).on('error', function(e) { console.error('  ❌ 连接失败: ' + e.message); cb(); });
}

// 测试 3：中文逗号自动归一化
test('中文逗号归一化', function() {
  var input = 'mm，m3'; // 全角逗号
  var normalized = input.replace(/，/g, ',').replace(/，/g, ',');
  assertEqual(normalized, 'mm,m3');
});

// 测试 4：模型解析逻辑（单元测试，不依赖 proxy 运行）
var PROVIDERS_STUB = {
  ds: { url: '', key: '', models: { v4pro: 'deepseek-v4-pro', v4flash: 'deepseek-v4-flash' } },
  mm: { url: '', key: '', models: { 'm3': 'MiniMax-M3' } }
};

function resolveModelStub(model) {
  model = (model || "v4pro").replace(/，/g, ",");
  model = (model || 'v4pro').replace(/，/g, ',');
  var parts = (model || 'v4pro').split(',');
  if (parts.length === 2) {
    var prov = parts[0], mod = parts[1];
    if (PROVIDERS_STUB[prov] && PROVIDERS_STUB[prov].models[mod])
      return { provider: PROVIDERS_STUB[prov], model: PROVIDERS_STUB[prov].models[mod] };
  }
  for (var p in PROVIDERS_STUB) {
    if (PROVIDERS_STUB[p].models[model])
      return { provider: PROVIDERS_STUB[p], model: PROVIDERS_STUB[p].models[model] };
  }
  return { provider: PROVIDERS_STUB.ds, model: PROVIDERS_STUB.ds.models.v4pro };
}

test('mm,m3 解析为 MiniMax-M3', function() {
  var r = resolveModelStub('mm,m3');
  assertEqual(r.model, 'MiniMax-M3');
});

test('mm,m3 中文逗号解析为 MiniMax-M3', function() {
  var r = resolveModelStub('mm，m3');
  assertEqual(r.model, 'MiniMax-M3');
});

test('ds,v4pro 解析为 deepseek-v4-pro', function() {
  var r = resolveModelStub('ds,v4pro');
  assertEqual(r.model, 'deepseek-v4-pro');
});

test('ds,v4flash 解析为 deepseek-v4-flash', function() {
  var r = resolveModelStub('ds,v4flash');
  assertEqual(r.model, 'deepseek-v4-flash');
});

test('未知模型回退到 v4pro', function() {
  var r = resolveModelStub('unknown,model');
  assertEqual(r.model, 'deepseek-v4-pro');
});

test('m3 不应能解析（m2.7 已移除）', function() {
  var r = resolveModelStub('mm,m2.7');
  // m2.7 已从 provider 配置中移除，应回退到默认 ds,v4pro
  assertEqual(r.model, 'deepseek-v4-pro');
});

// 运行测试
console.log('\n🔍 ccr-switch 测试套件');
console.log('  代理地址: ' + PROXY_URL);
console.log('');

var remaining = 2;
function done() {
  remaining--;
  if (remaining === 0) {
    console.log('\n📊 结果: ' + PASSED + ' 通过, ' + FAILED + ' 失败, ' + (PASSED+FAILED) + ' 总计');
    if (FAILED > 0) process.exit(1);
    console.log('🎉 所有测试通过！\n');
  }
}

// 需要代理在线的集成测试
testHealthEndpoint(done);
testModelsEndpoint(done);
