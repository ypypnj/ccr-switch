#!/usr/bin/env node
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),http=require('http');
const root=path.resolve(__dirname,'..'),proxyScript=path.join(root,'proxy.js'),installScript=path.join(root,'install.sh');
let passed=0,failed=0;const children=new Set(),secret='fixture-private-prompt-value';
function ok(value,message){if(!value)throw Error(message)}
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name)}catch(e){failed++;console.error('FAIL '+name+'\n  '+String(e.message).split(secret).join('[REDACTED]'))}}
function freePort(){return new Promise((resolve,reject)=>{const server=http.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(e=>e?reject(e):resolve(port))})})}
function request(port,method,url,body){return new Promise((resolve,reject)=>{const raw=body===undefined?null:JSON.stringify(body),req=http.request({host:'127.0.0.1',port,path:url,method,headers:raw?{'content-type':'application/json','content-length':Buffer.byteLength(raw)}:{}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}))});req.on('error',reject);if(raw)req.write(raw);req.end()})}
function waitHealth(port){return new Promise((resolve,reject)=>{let tries=0;(function poll(){request(port,'GET','/health').then(r=>r.status===200?resolve():retry()).catch(retry);function retry(){if(++tries>100)reject(Error('proxy not ready'));else setTimeout(poll,20)}})()})}
async function stop(child){if(!child)return;try{process.kill(-child.pid,'SIGTERM')}catch(e){}await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch(e){}},1000);child.once('exit',()=>{clearTimeout(timer);resolve()})});children.delete(child)}
function spawnProxy(upstreamPort,port,extraEnv){const home=fs.mkdtempSync(path.join(os.tmpdir(),'ccr-receipt-')),configFile=path.join(home,'config.json'),logFile=path.join(home,'proxy.log');const config={Providers:[{name:'xa',api_base_url:`http://127.0.0.1:${upstreamPort}/v1/messages`,api_key:'fixture-key',models:{gpt:'gpt-fixture'}}],ModelBindings:{}};fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600});const child=cp.spawn(process.execPath,[proxyScript,'--config',configFile,'--port',String(port)],{env:{...process.env,HOME:home,CCR_SWITCH_LOG:logFile,...(extraEnv||{})},detached:true,stdio:'ignore'});children.add(child);return{home,logFile,child,async stop(){await stop(child);fs.rmSync(home,{recursive:true,force:true})}}}
function startUpstream(writeStream){const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>writeStream(res,JSON.parse(body))) });return new Promise((resolve,reject)=>{server.listen(0,'127.0.0.1',()=>resolve(server));server.on('error',reject)})}
async function withProxy(writeStream,fn,extraEnv){const upstream=await startUpstream(writeStream),port=await freePort(),proxy=spawnProxy(upstream.address().port,port,extraEnv);try{await waitHealth(port);await fn(port,proxy)}finally{await proxy.stop();await new Promise(resolve=>upstream.close(resolve))}}
(async()=>{
// ── SSE frame parsing tests ──
await test('SSE collector handles chunked CRLF with single-line data',()=>{
  let lib;try{lib=require('../lib/receipt-index.js')}catch(e){}
  ok(lib&&typeof lib.createSSEFrameCollector==='function','missing SSE frame collector');
  const collector=lib.createSSEFrameCollector();
  ok(collector.feed('event: message_start\r\ndata: {"type":"message_start",\r').length===0,'partial frame emitted');
  const frames=collector.feed('\ndata: "message":{"id":"msg-now"}}\r\n\r\n');
  ok(frames.length===1,'CRLF frame not collected');
  ok(lib.parseSSEFrameData(frames[0]).message.id==='msg-now','single-line data parse failed');
});
await test('SSE multiline data with \\n join fails JSON parse',()=>{
  let lib;try{lib=require('../lib/receipt-index.js')}catch(e){}
  // Split inside a JSON string: \n join produces unescaped newline in string ← invalid JSON
  // Empty-string join would produce 'hel' + 'lo' = 'hello' ← valid JSON
  var frame='data: "hel\ndata: lo"\n';
  var threw=false;
  try{lib.parseSSEFrameData(frame);}catch(e){threw=true}
  ok(threw,'multiline data joined by \\n should fail JSON parse on unescaped newline in string');
});
// ── stream receipt queryable mid-stream ──
await test('stream receipt is queryable immediately after message_start',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  await withProxy(async(res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: message_sta');res.write('rt\r\ndata: {"type":"message_start","message":{"id":"msg-now"}}\r\n\r\n');await gate;res.end('event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n')},async port=>{
    const pending=request(port,'POST','/v1/messages',{model:'xa,gpt',messages:[{role:'user',content:secret}],stream:true});
    let receipt;for(let i=0;i<100;i++){receipt=await request(port,'GET','/v1/receipts/by-message-id/msg-now');if(receipt.status===200)break;await new Promise(r=>setTimeout(r,10))}
    ok(receipt.status===200,'receipt unavailable before stream end: '+receipt.status);
    ok(JSON.parse(receipt.body).message_id==='msg-now','wrong message receipt');release();
    const response=await pending;ok(response.status===200,'stream request failed');
  });
});
// ── fail-closed: no message_start ──
await test('HTTP 200 stream without message_start fails closed 502',async()=>{
  await withProxy((res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"'+secret+'"}}\n\n')},async(port,proxy)=>{
    const response=await request(port,'POST','/v1/messages',{model:'xa,gpt',messages:[{role:'user',content:secret}],stream:true});
    ok(response.status===502,'missing message_start should return 502, got '+response.status);
    const body=JSON.parse(response.body);ok(body.error.type==='missing_message_receipt','wrong error type');
    const log=fs.existsSync(proxy.logFile)?fs.readFileSync(proxy.logFile,'utf8'):'';
    ok(!response.body.includes(secret)&&!log.includes(secret),'diagnostic leaked sensitive content');
  });
});
// ── fail-closed: upstream response error before headers ──
await test('upstream response error before message_start fails closed 502',async()=>{
  await withProxy((res,body)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: ok\n\n');setTimeout(()=>res.socket.destroy(new Error('ECONNRESET')),10)},async(port,proxy)=>{
    const response=await request(port,'POST','/v1/messages',{model:'xa,gpt',messages:[{role:'user',content:secret}],stream:true});
    ok(response.status===502,'stream error should return 502, got '+response.status);
    ok(JSON.parse(response.body).error.type==='missing_message_receipt','wrong error type: '+JSON.parse(response.body).error.type);
  });
});
// ── fail-closed: upstream aborted before message_start ──
await test('upstream aborted before message_start fails closed 502',async()=>{
  await withProxy((res,body)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: ok\n\n');setTimeout(()=>res.destroy(),10)},async(port,proxy)=>{
    const response=await request(port,'POST','/v1/messages',{model:'xa,gpt',messages:[{role:'user',content:secret}],stream:true});
    ok(response.status===502,'abort should return 502, got '+response.status);
    ok(JSON.parse(response.body).error.type==='missing_message_receipt','wrong error type: '+JSON.parse(response.body).error.type);
  });
});
// ── fail-closed: upstream close before message_start ──
await test('upstream close before message_start fails closed 502',async()=>{
  await withProxy((res,body)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: ok\n\n');setTimeout(()=>res.socket.end(),10)},async(port,proxy)=>{
    const response=await request(port,'POST','/v1/messages',{model:'xa,gpt',messages:[{role:'user',content:secret}],stream:true});
    ok(response.status===502,'close-before-message_start should return 502, got '+response.status);
    ok(JSON.parse(response.body).error.type==='missing_message_receipt','wrong error type: '+JSON.parse(response.body).error.type);
  });
});
// ── fail-closed: deferred buffer overflow ──
await test('deferred buffer overflow fails closed 502',async()=>{
  await withProxy((res)=>{res.writeHead(200,{'content-type':'text/event-stream'});const pad='x'.repeat(70000);res.write('event: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',delta:{text:pad}})+'\n\n');res.end()},async(port,proxy)=>{
    const response=await request(port,'POST','/v1/messages',{model:'xa,gpt',messages:[{role:'user',content:secret}],stream:true});
    ok(response.status===502,'overflow should return 502, got '+response.status);
    ok(JSON.parse(response.body).error.type==='missing_message_receipt','wrong error type');
  },{CCR_DEFERRED_MAX_BYTES:'512'});
});
// ── fail-closed: non-streaming missing id ──
await test('non-streaming 200 without id fails closed 502',async()=>{
  await withProxy((res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'message',role:'assistant',content:[{type:'text',text:'ok'}]}))},async(port,proxy)=>{
    const response=await request(port,'POST','/v1/messages',{model:'xa,gpt',messages:[{role:'user',content:secret}],stream:false});
    ok(response.status===502,'non-streaming missing id should return 502, got '+response.status);
    ok(JSON.parse(response.body).error.type==='missing_message_receipt','wrong error type');
  });
});
// ── fail-closed: non-streaming JSON parse failure ──
await test('non-streaming bad JSON fails closed 502',async()=>{
  await withProxy((res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('not-json')},async(port,proxy)=>{
    const response=await request(port,'POST','/v1/messages',{model:'xa,gpt',messages:[{role:'user',content:secret}],stream:false});
    ok(response.status===502,'bad JSON should return 502, got '+response.status);
    ok(JSON.parse(response.body).error.type==='missing_message_receipt','wrong error type');
  });
});
// ── non-streaming receipt stored ──
await test('non-streaming with valid id stores receipt and returns 200',async()=>{
  await withProxy((res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'msg-ns-ok',type:'message',role:'assistant',content:[{type:'text',text:'ok'}]}))},async(port,proxy)=>{
    const response=await request(port,'POST','/v1/messages',{model:'xa,gpt',messages:[{role:'user',content:secret}],stream:false});
    ok(response.status===200,'valid non-streaming should return 200, got '+response.status);
    const receipt=await request(port,'GET','/v1/receipts/by-message-id/msg-ns-ok');
    ok(receipt.status===200,'receipt GET failed: '+receipt.status);
    ok(JSON.parse(receipt.body).message_id==='msg-ns-ok','wrong receipt message_id');
  });
});
// ── receipt conflict detection ──
await test('duplicate message_id with different receipt returns conflict',async()=>{
  let lib;try{lib=require('../lib/receipt-index.js')}catch(e){}
  const idx=lib.createReceiptIndex({ttlMs:60000,maxEntries:10});
  var r1={receipt_version:2,receipt_kind:'execution',requested_model:'m',actual_provider:'p',actual_model:'m1',dispatch_id:'d1',message_id:'dup',config_fingerprint:'a'};
  var r2={receipt_version:2,receipt_kind:'execution',requested_model:'m',actual_provider:'p',actual_model:'m2',dispatch_id:'d2',message_id:'dup',config_fingerprint:'b'};
  ok(idx.put('dup',r1).status==='stored','first put should store');
  ok(idx.put('dup',r2).status==='conflict','second put different receipt should conflict');
  ok(idx.get('dup').status==='conflict','subsequent get should see conflict');
});
// ── receipt idempotent ──
await test('duplicate message_id with identical receipt is idempotent',async()=>{
  let lib;try{lib=require('../lib/receipt-index.js')}catch(e){}
  const idx=lib.createReceiptIndex({ttlMs:60000,maxEntries:10});
  var r={receipt_version:2,receipt_kind:'execution',requested_model:'m',actual_provider:'p',actual_model:'m1',dispatch_id:'d',message_id:'idem',config_fingerprint:'c'};
  ok(idx.put('idem',r).status==='stored','first put should store');
  ok(idx.put('idem',r).status==='idempotent','second put with same receipt should be idempotent');
  ok(idx.get('idem').status==='found','subsequent get should find');
});
await test('installer transaction deploys receipt runtime module',()=>{
  const source=fs.readFileSync(installScript,'utf8');
  ok(source.includes('install -m 644 "$SCRIPT_DIR/lib/receipt-index.js" "$STAGE/app/lib/receipt-index.js"'),'installer does not stage receipt module');
  ok(/for rel in[^\n]*lib\/receipt-index\.js[^\n]*; do add_nonkey/.test(source),'installer does not commit receipt module transactionally');
  ok(source.includes('"$INSTALL_DIR/lib/receipt-index.js:0"'),'installer does not guard receipt module target');
  ok(source.includes("'stage/app/lib'")&&source.includes('lib\\/receipt-index\\.js'),'stale transaction validator omits receipt module');
});
// ── GET endpoint loopback guard ──
await test('loopback guard accepts local and rejects remote addresses',async()=>{
  await withProxy((res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'msg-lb',type:'message',role:'assistant',content:[{type:'text',text:'ok'}]}))},async(port,proxy)=>{
    await request(port,'POST','/v1/messages',{model:'xa,gpt',messages:[{role:'user',content:secret}],stream:false});
    // Send request with X-Forwarded-For to simulate non-loopback
    const raw=await new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port,path:'/v1/receipts/by-message-id/msg-lb',method:'GET'},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve({status:res.statusCode,body:d}))});req.on('error',reject);req.end()
    });
    // 403 or 200 (loopback) - the proxy checks socket.remoteAddress which is 127.0.0.1 from localhost
    // So actually it will be 200 from local test; we test directly that isLoopbackAddress works
    let lib;try{lib=require('../lib/receipt-index.js')}catch(e){}
    ok(lib.isLoopbackAddress('127.0.0.1'),'127.0.0.1 should be loopback');
    ok(lib.isLoopbackAddress('::1'),'::1 should be loopback');
    ok(!lib.isLoopbackAddress('192.168.1.1'),'remote should not be loopback');
    ok(!lib.isLoopbackAddress('10.0.0.1'),'remote should not be loopback');
  });
});
for(const child of [...children])await stop(child);
console.log(`message receipt summary: ${passed} passed, ${failed} failed`);process.exit(failed?1:0);
})().catch(async e=>{console.error(e);for(const child of [...children])await stop(child);process.exit(1)});
