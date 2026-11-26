import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { once } from 'node:events';
import { readSSE } from '../app/js/core/sse.js';
import { proxyChat } from '../server/agent-proxy.mjs';
import { readChat, saveChat, listChats } from '../server/chat-store.mjs';
import { createAgentLoop } from '../app/js/agent/loop.js';
import { createToolExecutor, mutationProject } from '../app/js/agent/tools.js';
import { sanitizeConversation, memoryChunks } from '../app/js/agent/conversation.js';
import { messageTokens } from '../app/js/agent/conversation.js';
import { estimateTokens } from '../app/js/agent/markdown.js';
import { fitConversation, summarizeContext, MAX_CHAT_BYTES, requestBytes } from '../app/js/agent/context-recovery.js';
import { contextUsage } from '../app/js/agent/context-usage.js';
import { FALLBACK_SKILLS, initialSkillIds } from '../app/js/agent/skills.js';
import { visualMessages } from '../app/js/agent/vision-messages.js';
import { getToolDefinitionsForPermission } from '../app/js/agent/tools.js';
import { buildSystemPrompt, buildSystemPromptSections } from '../app/js/agent/prompt.js';
import { CREATIVE_MOTION_GUIDE } from '../app/js/agent/creative-motion.js';
import { needsParallel3D,needsParallelSVG,prepareParallelBatch,createParallelRunner } from '../app/js/agent/parallel-agents.js';
import {checkSvgArtifact} from '../app/js/agent/svg-artifact.js';
import { normalizeCompaction, resolveCompaction, COMPACTION_PROMPT } from '../app/js/agent/compaction.js';
import { findModel, normalizeProvider } from '../app/js/agent/settings.js';
import { normalizeVisibleModels, providerModels, visibleProviderModels } from '../app/js/core/model-visibility.js';
import { archivePatch } from '../app/js/core/project-archive.js';
import { FAST_GENERATION_GUIDE } from '../app/js/agent/efficiency.js';
import { formatElapsed } from '../app/js/agent/generation-time.js';

test('Task planning follows effort mode while fast generation preserves safety and complete artifacts',async()=>{
  const seen=[];
  const f=checkpointFixture(async(p,cb)=>{
    const worker=p.messages[0].content.includes('Independent parallel worker');
    seen.push({worker,system:p.messages[0].content,effort:p.reasoning_effort});
    if(worker){emitText(cb,'Complete independent implementation and integration instructions.');return;}
    if(!p.messages.some(m=>m.role==='tool'))parallelCall(cb);else emitText(cb,'完成交付。');
  });
  await f.loop.load('test');assert.equal(f.loop.getOptions().fastMode,false);
  const original=buildSystemPrompt(f.ctx,{permission:'full'});assert(original.includes('Task planning by effort and scope'));assert(original.includes('call update_plan before implementation'));assert(!original.includes('## Efficient execution'));assert(!original.includes('Optional starting directions'));
  const fastSections=buildSystemPromptSections(f.ctx,{permission:'full',fastMode:true});
  assert.equal(fastSections.find(s=>s.id==='instructions').content,FAST_GENERATION_GUIDE);
  assert.deepEqual(fastSections.filter(s=>s.id!=='instructions'),buildSystemPromptSections(f.ctx,{permission:'full'}));
  f.loop.setOptions({fastMode:true,reasoningEffort:'none'});assert((await f.loop.send('完成两个独立部分')).ok);
  assert.equal(seen.filter(p=>p.worker).length,2);assert(seen.every(p=>p.effort==='none'&&p.system.includes(FAST_GENERATION_GUIDE)&&p.system.includes('Extended thinking is disabled')));
  assert(seen.every(p=>p.system.includes('check only the affected part')&&p.system.includes('Do not skip a failed check')));
  assert(!f.snapshot.settings.imageGeneration?.enabled);assert.equal(f.loop.permission,'edit');
  f.loop.setOptions({fastMode:false});assert(!buildSystemPrompt(f.ctx).includes(FAST_GENERATION_GUIDE));
});

test('Generation timing persists across stop, pause, resume and saved history, without charging idle time',async()=>{
  let entered;
  const first=new Promise(r=>entered=r);
  const f=fixture(async(p,cb,signal,n)=>{
    if(n===1){cb({type:'delta',content:'保留的进度。'});entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('stopped','AbortError')),{once:true}));}
    else {await new Promise(r=>setTimeout(r,25));emitText(cb,'已完成。');}
  });
  await f.loop.load('test');const work=f.loop.send('计时验收');await first;
  assert(f.loop.getState().runStartedAt>0);assert.equal(f.loop.getState().runElapsedMs,0);
  await new Promise(r=>setTimeout(r,25));f.loop.stop();await work;
  const stopped=f.loop.messages[0].generationTiming;assert.equal(stopped.status,'stopped');assert(stopped.elapsedMs>=25);assert.equal(f.loop.getState().runStartedAt,0);
  await new Promise(r=>setTimeout(r,35));assert.equal(f.loop.getState().runElapsedMs,stopped.elapsedMs);
  assert((await f.loop.resume()).ok);const done=f.loop.messages[0].generationTiming;
  assert.equal(done.status,'complete');assert(done.elapsedMs>=stopped.elapsedMs+25);assert(done.startedAt>=stopped.finishedAt);
  assert.deepEqual(f.saved.at(-1).body.messages[0].generationTiming,done);
  await f.loop.newChat();assert((await f.loop.send('新一轮')).ok);assert(f.loop.messages[0].generationTiming.startedAt>=done.finishedAt);
  for(const [ms,text] of [[0,'0:00'],[59999,'0:59'],[60000,'1:00'],[3601000,'1:00:01'],[-1,'0:00'],[NaN,'0:00']])assert.equal(formatElapsed(ms),text);
});

test('Disabled thinking reaches real OpenAI, DeepSeek, Qwen, Kimi and Anthropic wires and is never silently removed on rejection',async t=>{
  let model='gpt-5.1',wire='openai',effort='none',rejectOff=false,received=[];
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const b of req)raw+=b;received.push(JSON.parse(raw));
    res.writeHead(rejectOff?400:200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(rejectOff?{error:{message:'reasoning_effort none is unsupported'}}:wire==='anthropic'?{content:[{type:'text',text:'完成'}],stop_reason:'end_turn'}:{choices:[{message:{content:'完成'},finish_reason:'stop'}]}));
  });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const proxy=http.createServer((req,res)=>proxyChat({req,res,wire,base:'http://127.0.0.1:'+upstream.address().port,headers:{},model,messages:[{role:'user',content:'开始'}],tools:[],maxTokens:1024,stream:false,reasoningEffort:effort}));
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  t.after(async()=>{proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))]);});
  const call=async()=>{const response=await fetch('http://127.0.0.1:'+proxy.address().port),events=[];for await(const e of readSSE(response.body))events.push(JSON.parse(e.data));return events;};
  for(const [id,protocol,field,value] of [['gpt-5.1','openai','reasoning_effort','none'],['deepseek-chat','openai','thinking',{type:'disabled'}],['qwen3','openai','enable_thinking',false],['kimi-k2.5','openai','thinking',{type:'disabled'}],['claude-sonnet','anthropic','thinking',{type:'disabled'}]]){
    model=id;wire=protocol;const events=await call();assert(!events.some(e=>e.type==='error'),JSON.stringify(events));assert.deepEqual(received.at(-1)[field],value);
  }
  model='gpt-5.1';wire='openai';rejectOff=true;const before=received.length,events=await call();assert.equal(received.length,before+1);assert(events.some(e=>e.type==='error'&&e.message.includes('不支持此关闭思考参数')));
  rejectOff=false;effort='auto';await call();assert(!('reasoning_effort' in received.at(-1)));effort='high';await call();assert.equal(received.at(-1).reasoning_effort,'high');
});

test('Chat visibility preserves full provider catalogs, hidden active models and manually entered defaults',()=>{
  const raw={id:'custom-service',name:'我的服务',model:'manual',models:[{id:'a',tools:true},{id:'b'}, {id:'a'}]},p=normalizeProvider(raw);
  assert.equal(p.name,raw.name);assert.equal(p.visibleModels,null);assert.deepEqual(providerModels(p).map(m=>m.id),['a','b','manual']);
  const hidden=normalizeProvider({...raw,visibleModels:['b','b',' ',42]});assert.deepEqual(hidden.visibleModels,['b']);
  assert.deepEqual(visibleProviderModels(hidden).map(m=>m.id),['b']);assert.equal(findModel([hidden],hidden.id,'a').tools,true);
  assert.deepEqual(visibleProviderModels({...p,visibleModels:[]}),[]);assert.equal(p.model,'manual');
  assert.deepEqual(visibleProviderModels({...p,models:[...p.models,{id:'new-model'}]}).map(m=>m.id),['a','b','new-model','manual']);
  assert.deepEqual(normalizeVisibleModels(['a',' a ','b']),['a','b']);
});

test('Archiving is reversible metadata, preserves original archive time and rejects non-boolean state',()=>{
  const p={id:'original',files:['index.html'],versions:['v1'],chats:['conversation']};
  const archived={...p,...archivePatch(p,{archived:true},100)};assert.equal(archived.archivedAt,100);
  assert.deepEqual(archivePatch(archived,{archived:true},200),{archived:true,archivedAt:100});
  assert.deepEqual(archivePatch(archived,{name:'rename'}),{});
  const restored={...archived,...archivePatch(archived,{archived:false},300)};
  assert.deepEqual(restored,{...p,archived:false,archivedAt:0});assert.equal(archivePatch(restored,{archived:true},400).archivedAt,400);
  for(const archived of ['false',1,null])assert.throws(()=>archivePatch(p,{archived}),{status:400});
});

test('Visual evidence follows the entire tool batch, reaches vision models, and is excluded for text-only models',()=>{
  const image='data:image/png;base64,'+'a'.repeat(500000);
  const messages=[{role:'assistant',content:'Inspect',tool_calls:[{id:'a'},{id:'b'}]},
    {role:'tool',name:'deck_capture_slide',tool_call_id:'a',content:'{"ok":true}',images:[image]},
    {role:'tool',name:'deck_get_state',tool_call_id:'b',content:'{"ok":true}'}];
  const convert=m=>({role:m.role,content:m.content,tool_call_id:m.tool_call_id,tool_calls:m.tool_calls});
  const yes=visualMessages(messages,convert,true),no=visualMessages(messages,convert,false);
  assert.deepEqual(yes.map(m=>m.role),['assistant','tool','tool','user']);
  assert.equal(yes.at(-1).content[1].image_url.url,image);assert.equal(no.length,3);
  assert(messageTokens(yes)<3000,'base64 bytes must not count as text tokens');
  assert(!getToolDefinitionsForPermission('full',{vision:false}).some(t=>t.function.name==='deck_capture_slide'));
  assert(getToolDefinitionsForPermission('read',{vision:true}).some(t=>t.function.name==='deck_capture_slide'));
});

test('Built-in design prompts and every skill body use English instructions without changing UI names',async()=>{
  const prompt=buildSystemPrompt({store:{get:()=>({settings:{}})}},{permission:'full',vision:true});
  assert(!/[\u3400-\u9fff]/.test(prompt));assert(prompt.includes('user\'s language'));assert(prompt.includes('deck_capture_slide'));assert(prompt.includes('style:"custom"'));
  let count=0;
  async function check(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.isDirectory()&&e.name!=='licenses')await check(path.join(dir,e.name));else if(e.name.endsWith('.md')){const raw=await fs.readFile(path.join(dir,e.name),'utf8'),m=/^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw);if(m){count++;assert(!/[\u3400-\u9fff]/.test(raw.slice(m[0].length)),e.name);}}}}
  await check(fileURLToPath(new URL('../skills/',import.meta.url)));assert.equal(count,11);
});

test('Detailed drawing guides reach SVG/Three.js tasks automatically without bloating unrelated requests',()=>{
  const ctx={store:{get:()=>({settings:{}})}};
  const base=buildSystemPrompt(ctx,{permission:'full'}),svg=buildSystemPrompt(ctx,{permission:'full',visualTask:'绘制 SVG 剖面图'}),three=buildSystemPrompt(ctx,{permission:'full',visualTask:'构建三维模型'});
  assert(!base.includes('### 1. Establish the drawing brief'));
  for(const phrase of ['### 1. Establish the drawing brief','### 8. Inspect pixels','attachment points','cutaway','1,000,000-character','artifact:"svg"'])assert(svg.includes(phrase),phrase);
  assert(three.includes('### Build meaningful geometry'));assert(three.includes('### Acceptance and refinement'));
  const worker=buildSystemPrompt(ctx,{permission:'read',visualArtifact:'svg'});assert(worker.includes('### 1. Establish the drawing brief'));
  assert(!/[\u3400-\u9fff]/.test(worker));
});

test('SVG artifact checks distinguish complete source from a plan or broken/truncated XML without claiming visual quality',()=>{
  const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 700"><title>Assembly</title><g id="parts"><path d="M10 20H60"/></g></svg>';
  const checked=checkSvgArtifact('```svg\n'+svg+'\n```\nIntegration: x=200; y=180.');
  assert(checked.ok);assert.equal(checked.visualInspection,false);assert.deepEqual(checked.viewBox,[0,0,1200,700]);
  for(const bad of ['I will draw a detailed assembly later.','<svg><g>',svg.replace('</g>',''),svg.replace('viewBox="0 0 1200 700"','viewBox="0 0 -1 0"'),svg.replace('xmlns="http://www.w3.org/2000/svg"',''),svg+svg])assert.equal(checkSvgArtifact(bad).ok,false,bad);
});

test('SVG routing covers substantial illustration and redraws while preserving focused fixes, questions and opt-outs',()=>{
  for(const text of ['绘制一个十分详细的 SVG 电机剖面图','请用SVG画出细胞结构','重新画这张 SVG 插图','Create a detailed SVG illustration','不要三维，绘制 SVG 图解'])assert(needsParallelSVG(text),text);
  for(const text of ['SVG 是什么？','Explain SVG','如何绘制 SVG？','不要 SVG，改用照片','不要绘制SVG','不要子代理，绘制SVG','不使用子智能体，请绘制 SVG','把SVG标题改成红色','只调整SVG的字号','only change the SVG label color','调整 SVG 的绝对大小','导出的 SVG 为什么那么大'])assert.equal(needsParallelSVG(text),false,text);
});

test('Shared drawing contracts and artifact roles are durable, validated and part of batch identity',()=>{
  const turn={},tasks=[{id:'body',role:'implement',artifact:'svg',task:'Draw complete motor body SVG.'},{id:'check',role:'review',artifact:'analysis',task:'Check geometry and label placements.'}];
  const opts={active:{providerId:'test',model:'test'},toolCallId:'a'};
  const a=prepareParallelBatch(turn,{tasks,sharedContext:'viewBox 0 0 1200 700; prefix motor; annotation lane x=920.'},opts);
  assert.equal(prepareParallelBatch(turn,{tasks,sharedContext:a.sharedContext},opts),a);
  const b=prepareParallelBatch(turn,{tasks,sharedContext:'Different coordinate ownership'},opts);assert.notEqual(a.id,b.id);
  assert.equal(a.workers[0].artifact,'svg');assert.equal(a.workers[1].artifact,'analysis');
  assert.throws(()=>prepareParallelBatch({}, {tasks:[{...tasks[0],artifact:'bitmap'},tasks[1]]},opts),/artifact/);
  assert.throws(()=>prepareParallelBatch({}, {tasks,sharedContext:{}},opts),/共享/);
});

test('OpenAI and Anthropic upstream requests receive real visual image blocks after tool results',async()=>{
  let wire='openai',received;
  const image='data:image/png;base64,aGVsbG8=';
  const messages=visualMessages([{role:'user',content:'Inspect page'},
    {role:'assistant',content:'',tool_calls:[{id:'capture',type:'function',function:{name:'deck_capture_slide',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'capture',name:'deck_capture_slide',content:'{"ok":true}',images:[image]}],m=>({...m,images:undefined}),true);
  const upstream=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;received=JSON.parse(raw);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(wire==='anthropic'?{content:[{type:'text',text:'Viewed'}],stop_reason:'end_turn'}:{choices:[{message:{content:'Viewed'},finish_reason:'stop'}]}));});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const proxy=http.createServer((req,res)=>proxyChat({req,res,base:'http://127.0.0.1:'+upstream.address().port,wire,headers:{},model:'vision',messages,tools:[],maxTokens:1024,stream:false}));
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  try{for(wire of ['openai','anthropic']){
    const r=await fetch('http://127.0.0.1:'+proxy.address().port);const events=[];for await(const e of readSSE(r.body))events.push(JSON.parse(e.data));assert(!events.some(e=>e.type==='error'));
    if(wire==='openai'){assert.equal(received.messages.at(-1).content[1].image_url.url,image);assert.equal(received.messages.at(-2).role,'tool');}
    else {const blocks=received.messages.at(-1).content;assert.equal(blocks[0].type,'tool_result');assert.equal(blocks.at(-1).type,'image');assert.equal(blocks.at(-1).source.media_type,'image/png');}
  }}finally{proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))]);}
});

globalThis.localStorage = { data: new Map(), getItem(k) { return this.data.get(k) || null; }, setItem(k, v) { this.data.set(k, v); }, removeItem(k) { this.data.delete(k); } };
const emitText = (fn, text, reason = 'stop') => { fn({ type: 'delta', content: text }); fn({ type: 'done', finish_reason: reason }); };
function fixture(handler, messages = [], options = {}) {
  localStorage.data.clear();
  const snapshot = { agent: {}, project: { id: 'test', name: '测试' }, deck: { total: 1, current: 0, slides: [] }, history: { ops: [], cursor: 0 }, settings: {
    loaded: true, providers: [{ id: 'test', name: 'test', keySet: true, model: 'test', models: [{ id: 'test', contextLength: 131072, maxOutput: 8192 }] }], agent: { contextLimit: 131072, maxTokens: 8192 },
  } };
  Object.assign(snapshot.settings.agent, options);
  const saved = [], requests = [], hooks = { errors: [], done: [] };
  const ctx = { store: { get: () => snapshot, update: (fn) => fn(snapshot) }, bus: { listCommands: () => [], emit() {}, hasCommand: () => true, runCommand: async () => ({ ok: true }) },
    api: { skills: async () => ({ skills: [] }), getChat: async () => ({ messages, skills: [] }), putChat: async (id, body, session) => { saved.push(structuredClone({ id, body, session })); }, listChats: async () => ({ chats: [] }),
      chatStream: async (payload, callback, signal) => { requests.push(payload); await handler(payload, callback, signal, requests.length); } },
  };
  const loop = createAgentLoop(ctx, { onError: (e) => hooks.errors.push(e), onDone: (e) => hooks.done.push(e) });
  return { ctx, loop, snapshot, requests, saved, hooks };
}

function checkpointFixture(handler, history = []) {
  const f = fixture(handler, history), versions = [], writes = [];
  f.ctx.api.createVersion = async (id, options) => { const version = { id: 'version-' + versions.length }; versions.push(structuredClone({ id, options, version })); return { version }; };
  f.ctx.bus.runCommand = async (name) => { writes.push({ name, snapshotsBeforeWrite: versions.length }); return { ok: true }; };
  return { ...f, versions, writes };
}

test('Browser screenshots reach vision models and can be saved as permission-checked project assets', async () => {
  const image = 'data:image/jpeg;base64,/9j/example';
  const f = checkpointFixture(async (payload, emit, _signal, round) => {
    assert(payload.tools.some(tool => tool.function.name === 'browser_use'));
    if (round === 1) return teamCall(emit, 'browser_use', { action: 'screenshot' });
    assert(payload.messages.some(message => Array.isArray(message.content) &&
      message.content.some(part => part.image_url?.url === image)));
    emitText(emit, '已查看网页。');
  });
  let scope;
  f.ctx.api.browser = async body => {
    scope = body;
    return { ok: true, open: true, url: 'https://example.com/', images: [image] };
  };
  f.snapshot.settings.providers[0].models[0].vision = true;
  await f.loop.load('test');
  assert((await f.loop.send('查看网页')).ok, f.hooks.errors.at(-1)?.message);
  assert.deepEqual(scope, { projectId: 'test', sessionId: 'default', action: 'screenshot' });
  assert.deepEqual(f.saved.at(-1).body.messages.find(message => message.name === 'browser_use').images, [image]);
  assert.deepEqual(f.versions.map(version => version.options.kind), ['before', 'after']);

  let uploads = 0;
  f.ctx.api.uploadAssetDataUrl = async (projectId, filename, dataUrl) => {
    uploads++;
    assert.deepEqual([projectId, filename, dataUrl], ['test', 'browser-screenshot.jpg', image]);
    return { url: 'assets/example.jpg' };
  };
  const tools = createToolExecutor(f.ctx);
  assert.equal((await tools.execute('browser_save_screenshot', {}, { permission: 'read' })).ok, false);
  assert.equal(uploads, 0);
  const saved = await tools.execute('browser_save_screenshot', {}, { permission: 'edit' });
  assert.equal(saved.path, 'assets/example.jpg');
  assert.equal(uploads, 1);
});

test('The main Agent pauses after 256 tool rounds and can continue the same task', async () => {
  const f = fixture(async (_payload, emit, _signal, round) => {
    if (round > 256) {
      emitText(emit, '已完成。');
      return;
    }
    emit({ type: 'tool_calls', tool_calls: [{
      id: 'state-' + round, type: 'function', function: { name: 'deck_get_state', arguments: '{}' },
    }] });
    emit({ type: 'done', finish_reason: 'tool_calls' });
  });
  await f.loop.load('test');
  assert.equal((await f.loop.send('检查当前文稿')).ok, false);
  assert.equal(f.requests.length, 256);
  assert.equal(f.saved.at(-1).body.messages.filter(message => message.role === 'tool').length, 256);
  assert.match(f.hooks.errors.at(-1).message, /256 轮处理上限/);
  assert.equal((await f.loop.resume()).ok, true);
  assert.equal(f.loop.messages.filter(message => message.role === 'user').length, 1);
});

test('Compose accepts 48 slides and rejects 49 without changing the deck', async () => {
  const f = fixture(async () => {});
  const pages = ['old slide'];
  f.ctx.getEditor = () => ({ bridge: { async call(method, params) {
    if (method === 'getState') return { slides: pages.slice() };
    if (method === 'addSlide') pages.splice(params.afterIndex + 1, 0, '');
    if (method === 'setSlideHtml') pages[params.index] = params.html;
    return { ok: true };
  } } });
  const slides = Array.from({ length: 49 }, (_, i) => ({ name: '页面 ' + (i + 1), html: '<p>正文</p>' }));
  const tools = createToolExecutor(f.ctx);
  const schema = getToolDefinitionsForPermission('edit').find(tool => tool.function.name === 'deck_compose');
  assert.equal(schema.function.parameters.properties.slides.maxItems, 48);
  assert.match((await tools.execute('deck_compose', { slides }, { permission: 'edit' })).error, /48 页/);
  assert.deepEqual(pages, ['old slide']);
  const result = await tools.execute('deck_compose', { slides: slides.slice(0, 48) }, { permission: 'edit' });
  assert.equal(result.pages, 48);
  assert.equal(pages.length, 48);
  assert.match(pages.at(-1), /data-name="页面 48"/);
});

test('Compose recovers valid stringified slides and rejects damaged content before any checkpoint', async () => {
  const f = checkpointFixture(async () => {});
  const changes = [];
  f.ctx.getEditor = () => ({ bridge: { async call(method, params) {
    if (method === 'getState') return { slides: [{ id: 'old' }] };
    changes.push([method, params]);
    return { ok: true };
  } } });
  const tools = createToolExecutor(f.ctx);
  let checkpoints = 0;
  const opts = { permission: 'edit', beforeMutation: () => { checkpoints++; } };
  const broken = '[{"name":"Opening","elements":[{"type":"text","text":"Text with "unescaped quotes"."}]}]';
  for (const slides of [undefined, [], broken, [null], [{ elements: '{}' }]]) {
    const result = await tools.execute('deck_compose', { slides }, opts);
    assert.equal(result.code, 'INVALID_COMPOSE_SLIDES', JSON.stringify(result));
  }
  assert.equal(checkpoints, 0);
  assert.deepEqual(changes, []);
  const slides = [{ name: 'Opening', elements: [{ type: 'text', text: 'Text with "escaped quotes".' }] }];
  const result = await tools.execute('deck_compose', { slides: JSON.stringify(slides) }, opts);
  assert.equal(result.pages, 1);
  assert.equal(checkpoints, 1);
  assert.match(changes.find(([method]) => method === 'setSlideHtml')[1].html, /Text with (?:&quot;|")escaped quotes(?:&quot;|")/);
});

test('Compose argument failures retry once and switch to incremental generation', async () => {
  const f = checkpointFixture(async (request, emit, _signal, round) => {
    const tool = name => request.tools.some(({ function: fn }) => fn.name === name);
    const system = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const brokenSlides = '[{"name":"Opening","html":"<div class="title">Title</div>"}]';
    if (round <= 2) {
      assert(tool('deck_compose'));
      assert.equal(request.toolChoice, undefined);
      if (round === 2) assert.match(system, /arguments were rejected/);
      teamCall(emit, 'deck_compose', { slides: brokenSlides });
    } else if (round === 3) {
      assert(!tool('deck_compose'));
      assert.match(system, /Continue this deck incrementally/);
      assert(tool('deck_add_slide'));
      teamCall(emit, 'deck_add_slide', { afterIndex: 0, html: '<div>Title</div>' });
    } else {
      emitText(emit, '已写入演示。');
    }
  });
  const writes = [];
  f.ctx.getEditor = () => ({ bridge: { async call(method, params) {
    if (method === 'getState') return { slides: [{ id: 'blank' }] };
    writes.push([method, params]);
    return { ok: true };
  } } });
  await f.loop.load('test');
  const result = await f.loop.send('Create a presentation', [], { brief: 'Deliver two finished pages.' });
  assert(result.ok, f.hooks.errors.at(-1)?.message);
  assert.equal(f.requests.length, 4);
  assert.deepEqual(writes, [['addSlide', { afterIndex: 0, html: '<div>Title</div>' }]]);
  assert.deepEqual(f.versions.map(version => version.options.kind), ['before', 'after']);
});

test('Individually forced skills reload full source for main and parallel requests', async () => {
  let reads = 0;
  const f = fixture(async (p, cb) => {
    const system = p.messages[0].content;
    assert(system.includes('Required skill IDs: ["motion-design"]'));
    assert(system.includes('FORCED_FULL_SOURCE_TAIL'));
    assert(!system.includes('UNSELECTED_FORCE_SOURCE'));
    if (p.sessionId.includes(':parallel:')) { emitText(cb, 'Complete independent implementation.'); return; }
    if (!p.messages.some(m => m.role === 'tool')) parallelCall(cb);
    else emitText(cb, '完成交付。');
  }, [], { userInstructions: { skillForceOverrides: { 'motion-design': true, 'svg-illustration': true } } });
  f.ctx.api.skills = async () => {
    reads++;
    return { skills: FALLBACK_SKILLS.filter(s => ['motion-design', 'svg-illustration'].includes(s.id)).map(s => ({
      ...s, content: s.id === 'motion-design' ? 'Apply this complete skill. FORCED_FULL_SOURCE_TAIL' : 'UNSELECTED_FORCE_SOURCE',
    })) };
  };
  await f.loop.load('test');
  assert((await f.loop.send('完成两个独立实现部分')).ok);
  assert(reads >= 4);
  assert.equal(f.requests.filter(p => p.sessionId.includes(':parallel:')).length, 2);
});

test('Forced skill loading failures stop requests instead of silently using empty or cached source', async () => {
  for (const broken of [async () => { throw Error('Skill service unavailable'); }, async () => ({ skills: [] })]) {
    const f = fixture(async (_, cb) => emitText(cb, 'This must not run'), [], { userInstructions: { forceSkills: true } });
    await f.loop.load('test'); f.ctx.api.skills = broken;
    assert(!(await f.loop.send('使用强制 Skill')).ok);
    assert.equal(f.requests.length, 0);
    assert(f.hooks.errors.length);
  }
});
function toolReply(cb, names = ['insert.text']) {
  cb({ type: 'tool_calls', tool_calls: names.map((name, i) => ({ id: 'write-' + i, type: 'function', function: { name: 'app_run_command', arguments: JSON.stringify({ name }) } })) });
  cb({ type: 'done', finish_reason: 'tool_calls' });
}

function teamFixture(handler) {
  const f=checkpointFixture(handler);
  f.snapshot.settings.providers[0].models=['design','implement','review'].map(id=>({id,contextLength:131072,maxOutput:id==='implement'?16000:8192}));
  f.snapshot.settings.providers[0].model='design';
  f.snapshot.settings.agent.maxTokens=0;
  f.snapshot.settings.agent.collaboration=Object.fromEntries(['design','implement','review'].map(role=>[role,{providerId:'test',model:role}]));
  return f;
}
function teamCall(cb,name,args={}) {
  cb({type:'tool_calls',tool_calls:[{id:'team-'+Math.random().toString(36).slice(2),type:'function',function:{name,arguments:JSON.stringify(args)}}]});cb({type:'done',finish_reason:'tool_calls'});
}
function teamTransfer(cb,target,task='具体任务与检查依据') {teamCall(cb,'agent_handoff',{target,task});}

const parallelTasks=[{id:'geometry',role:'implement',task:'Generate complete geometry and scene JSON; return code for the coordinator.'},{id:'interaction',role:'review',task:'Design interaction and validation; return complete integration instructions.'}];
const parallelCall=(cb,tasks=parallelTasks)=>teamCall(cb,'agent_parallel',{tasks});

test('Expressive motion adds exactly one English guide only when explicitly enabled and preserves the original prompt when off',()=>{
  const ctx={store:{get:()=>({settings:{imageGeneration:{enabled:false}}})}},options={permission:'edit',vision:true,skillsText:'Existing design skill.'};
  const original=buildSystemPrompt(ctx,options),disabled=buildSystemPrompt(ctx,{...options,creativeMotion:false}),enabled=buildSystemPrompt(ctx,{...options,creativeMotion:true});
  assert.equal(disabled,original);assert.equal(enabled.replace(CREATIVE_MOTION_GUIDE+'\n\n',''),original);assert.equal(enabled.split(CREATIVE_MOTION_GUIDE).length,2);assert(!/[\u3400-\u9fff]/.test(CREATIVE_MOTION_GUIDE));
  for(const phrase of ['Transitions MUST','Element animation MUST','A real timeline MUST','Background design MUST','deck_set_custom_transition','deck_get_timeline','deck_set_timeline','deck_generate_image','SVG creativity','3D creativity','prefers-reduced-motion','do not enable it','narrowly scoped follow-up'])assert(enabled.includes(phrase),phrase);
  assert(enabled.includes('Image generation is disabled'));assert(original.includes('Image generation is disabled'));
});

test('System prompt sections keep policies, capabilities, optional guidance, verification and live context in order', () => {
  const snapshot = { project: { id: 'example' }, settings: { imageGeneration: { enabled: true }, agent: { userInstructions: { enabled: true, prompt: 'User preference marker', skills: [] } } } };
  const ctx = { store: { get: () => snapshot } };
  const sections = buildSystemPromptSections(ctx, { permission: 'read', roleInstructions: 'Current role marker', skillsText: 'Enabled skill marker', creativeMotion: true, fastMode: true, webSearch: true, visualTask: 'draw svg' });
  assert.deepEqual(sections.map(s => s.id), ['execution', 'authoring', 'capabilities', 'instructions', 'verification', 'context']);
  assert(sections[0].content.includes('Read only.')); assert(sections[0].content.includes('Current role marker'));
  assert(sections[1].content.includes('## Editable HTML contract')); assert(sections[1].content.includes('## Autonomous chapter navigation'));
  assert(sections[2].content.includes('## SVG illustration:')); assert(sections[2].content.includes('## Image assets')); assert(sections[2].content.includes('does not insert images'));
  assert(sections[3].content.includes('Enabled skill marker')); assert(sections[3].content.includes('User preference marker')); assert(sections[3].content.includes(CREATIVE_MOTION_GUIDE));
  assert(sections[4].content.includes('## Visual feedback loop')); assert(sections[5].content.includes('"id":"example"'));
});

test('Expressive motion toggles real model requests and context estimates without enabling image generation or changing permissions',async()=>{
  const f=fixture(async(p,cb)=>emitText(cb,'完成说明。'));
  await f.loop.load('test');assert.equal(f.loop.getOptions().creativeMotion,false);
  await f.loop.send('普通创作');const before=f.loop.getState().context.breakdown.system;
  f.loop.setOptions({creativeMotion:true,permission:'read'});assert(f.loop.getOptions().creativeMotion);assert(f.snapshot.agent.creativeMotion);
  assert((await f.loop.send('审阅华丽方案')).ok);assert(f.requests.at(-1).messages[0].content.includes(CREATIVE_MOTION_GUIDE));
  assert(f.loop.getState().context.breakdown.system > before);
  assert(f.requests.at(-1).messages[0].content.includes('Read only.'));assert(!f.requests.at(-1).tools.some(t=>t.function.name==='deck_generate_image'));
  assert(!f.snapshot.settings.imageGeneration?.enabled);assert.equal(f.loop.permission,'read');
  f.loop.setOptions({creativeMotion:false});assert((await f.loop.send('关闭后继续')).ok);
  assert(!f.requests.at(-1).messages[0].content.includes(CREATIVE_MOTION_GUIDE));assert.equal(f.loop.messages.length,6);
  assert(!f.requests[0].messages[0].content.includes(CREATIVE_MOTION_GUIDE));
});

test('All extreme-effort roles and independent background workers inherit expressive motion instructions',async()=>{
  const roles=[];
  const team=teamFixture(async(p,cb)=>{
    assert(p.messages[0].content.includes(CREATIVE_MOTION_GUIDE));roles.push(p.model);
    if(roles.length===1)teamTransfer(cb,'implement');else if(roles.length===2)teamTransfer(cb,'review');
    else if(roles.length===3)teamCall(cb,'deck_get_state');else if(roles.length===4)teamTransfer(cb,'complete');else emitText(cb,'交付。');
  });
  team.ctx.getEditor=()=>({projectId:'test',bridge:{call:async()=>({slides:[],current:0})}});
  await team.loop.load('test');team.loop.setOptions({creativeMotion:true,reasoningEffort:'xhigh'});assert((await team.loop.send('创作并检查')).ok);
  assert.deepEqual(roles,['design','implement','review','review','design']);
  let lead=0;const seen=[];
  const parallel=fixture(async(p,cb)=>{
    assert(p.messages[0].content.includes(CREATIVE_MOTION_GUIDE));
    if(p.sessionId.includes(':parallel:')){seen.push(p.sessionId);assert(p.messages[0].content.includes('Read only.'));emitText(cb,'完整创作实现方案。');return;}
    if(++lead===1){parallelCall(cb);return;}if(lead===2){teamCall(cb,'agent_wait',{});return;}emitText(cb,'已收集并检查。');
  });
  await parallel.loop.load('test');parallel.loop.setOptions({creativeMotion:true});assert((await parallel.loop.send('并行设计不同场景')).ok);assert.equal(seen.length,2);
});

const svgDrawing='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 700"><title>Motor assembly</title><defs><marker id="motor-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#44ccee"/></marker></defs><g id="motor-stator"><circle cx="500" cy="350" r="200" fill="none" stroke="#44ccee" stroke-width="28"/></g><g id="motor-rotor"><path d="M360 350H640" stroke="#eeaa44" stroke-width="60"/><circle cx="500" cy="350" r="42" fill="#334455"/></g><g id="motor-labels"><text x="820" y="180" font-size="32">Stator winding</text><path d="M810 190H720L670 240" fill="none" stroke="#44ccee" marker-end="url(#motor-arrow)"/></g></svg>';

test('SVG specialists receive detailed guides and a shared coordinate contract, continue full source across output limits, and do not block lead layout', {timeout:5000},async()=>{
  let lead=0,release;const layoutReady=new Promise(r=>release=r),counts={body:0,annotations:0},events=[];
  const tasks=[{id:'body',role:'implement',artifact:'svg',task:'Draw the complete motor assembly SVG and its meaningful internals.'},{id:'annotations',role:'review',artifact:'analysis',task:'Verify motor topology and callout endpoints against the shared coordinates.'}];
  const sharedContext='viewBox 0 0 1200 700; origin 0,0; motor center 500,350; component prefix motor; labels x=820.';
  const split=Math.floor(svgDrawing.length*.6);
  const f=checkpointFixture(async(p,cb)=>{
    if(p.sessionId.includes(':parallel:')){
      const id=p.sessionId.split(':').at(-1);counts[id]++;
      assert(p.messages[0].content.includes('### 1. Establish the drawing brief'));
      assert(p.messages.some(m=>String(m.content).includes(sharedContext)));
      assert(!p.tools.some(t=>['deck_insert_svg','file_write','agent_parallel'].includes(t.function.name)));
      await layoutReady;events.push(id);
      if(id==='body')emitText(cb,counts.body===1?'```svg\n'+svgDrawing.slice(0,split):svgDrawing.slice(split)+'\n```\nBounds x=100 y=200 w=1200 h=700; source not applied.',counts.body===1?'length':'stop');
      else emitText(cb,'Annotation anchors verified against the supplied inventory; inspect the integrated image.');
      return;
    }
    if(++lead===1){teamCall(cb,'agent_parallel',{tasks,sharedContext});return;}
    if(lead===2){toolReply(cb);return;}
    if(lead===3){teamCall(cb,'agent_wait',{});return;}
    const batch=JSON.parse(p.messages.find(m=>m.role==='tool'&&m.content.includes('batchId')).content);
    const body=batch.workers.find(w=>w.id==='body');assert(body.content.includes(svgDrawing));assert(body.artifactChecks.ok);assert.equal(body.artifactChecks.visualInspection,false);
    emitText(cb,'Complete artifacts collected for integration.');
  });
  const write=f.ctx.bus.runCommand;f.ctx.bus.runCommand=async name=>{events.push('lead-layout');const result=await write(name);release();return result;};
  await f.loop.load('test');assert((await f.loop.send('请绘制十分详细的 SVG 电机剖面图')).ok);
  assert.equal(f.requests[0].toolChoice.function.name,'agent_parallel');assert.equal(events[0],'lead-layout');assert.deepEqual(counts,{body:2,annotations:1});
  const saved=f.saved.at(-1).body.messages.find(m=>m.role==='user').parallelRuns[0];assert.equal(saved.sharedContext,sharedContext);assert(saved.workers[0].content.includes(svgDrawing));assert.equal(saved.workers[0].artifact,'svg');
});

test('SVG specialists repair a prose-only or malformed artifact before being marked complete, without rerunning successful siblings',async()=>{
  const counts={drawing:0,review:0};let lead=0;
  const tasks=[{id:'drawing',role:'implement',artifact:'svg',task:'Draw a full SVG assembly.'},{id:'review',role:'review',artifact:'analysis',task:'Verify the intended labels.'}];
  const f=fixture(async(p,cb)=>{
    if(p.sessionId.includes(':parallel:')){
      const id=p.sessionId.split(':').at(-1),n=++counts[id];
      if(id==='review')emitText(cb,'Semantic labels checked.');
      else if(n===1)emitText(cb,'I will draw it later.');
      else if(n===2){assert(p.messages.at(-1).content.includes('Reissue the FULL'));emitText(cb,'```svg\n<svg><g>\n```');}
      else emitText(cb,'```svg\n'+svgDrawing+'\n```');return;
    }
    if(++lead===1)parallelCall(cb,tasks);else if(lead===2)teamCall(cb,'agent_wait',{});else emitText(cb,'Collected a complete corrected drawing.');
  });
  await f.loop.load('test');assert((await f.loop.send('绘制 SVG 结构图')).ok);assert.deepEqual(counts,{drawing:3,review:1});
  const drawing=f.loop.messages[0].parallelRuns[0].workers[0];assert.equal(drawing.status,'complete');assert(drawing.artifactChecks.ok);assert(drawing.content.includes(svgDrawing));
});

test('A worker that repeatedly omits SVG source cannot become a successful final delivery',async()=>{
  let lead=0,count=0;
  const tasks=[{id:'drawing',role:'implement',artifact:'svg',task:'Draw an SVG assembly.'},{id:'review',role:'review',artifact:'analysis',task:'Review the plan.'}];
  const f=fixture(async(p,cb)=>{
    if(p.sessionId.includes(':parallel:')){if(p.sessionId.endsWith(':drawing'))count++;emitText(cb,'Outline only.');return;}
    if(++lead===1)parallelCall(cb,tasks);else if(lead===2)teamCall(cb,'agent_wait',{});else emitText(cb,'Attempted final answer.');
  });
  await f.loop.load('test');assert.equal((await f.loop.send('绘制完整 SVG 图')).ok,false);assert.equal(count,3);
  const w=f.loop.messages[0].parallelRuns[0].workers[0];assert.equal(w.status,'error');assert.equal(w.artifactChecks.ok,false);assert(w.error.includes('完整可用源码'));
});

test('Read-only SVG requests and focused label fixes keep rewind snapshots without forcing delegation',async()=>{
  for(const read of [true,false]){
    const f=checkpointFixture(async(p,cb)=>{assert.notEqual(p.toolChoice?.function?.name,'agent_parallel');emitText(cb,'Focused analysis.');});
    await f.loop.load('test');if(read)f.loop.setOptions({permission:'read'});
    assert((await f.loop.send(read?'绘制完整 SVG 电机结构图':'只调整 SVG 标签字号')).ok);assert.equal(f.versions.length,2);
  }
});

test('3D authoring dispatches genuinely overlapping read-only workers using the active model outside extreme effort',async()=>{
  let workers=0,release;const bothStarted=new Promise(r=>release=r),active=new Set(),attempts=new Map();
  const f=checkpointFixture(async(p,cb)=>{
    if(p.sessionId.includes(':parallel:')){
      assert.equal(p.model,'test');assert(!p.tools.some(t=>['deck_set_text','file_write','agent_handoff','agent_parallel'].includes(t.function.name)));
      const id=p.sessionId.split(':').at(-1),n=(attempts.get(id)||0)+1;attempts.set(id,n);
      if(n===1){active.add(id);if(++workers===2)release();await bothStarted;assert.equal(active.size,2);}
      if(id==='geometry'&&n===1){teamCall(cb,'app_run_command',{name:'insert.text'});return;}
      if(id==='geometry')assert.equal(JSON.parse(p.messages.findLast(m=>m.role==='tool').content).ok,false);
      cb({type:'usage',usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});emitText(cb,id==='geometry'?'Complete geometry code':'Interaction and validation code');return;
    }
    const result=p.messages.findLast(m=>m.role==='tool'&&JSON.parse(m.content).workers);
    if(!result){assert.equal(p.toolChoice.function.name,'agent_parallel');parallelCall(cb);}
    else {const batch=JSON.parse(result.content);if(!batch.complete){teamCall(cb,'agent_wait',{batchId:batch.batchId});return;}assert(batch.ok);assert.equal(batch.workers.length,2);assert(batch.workers.every(w=>w.status==='complete'));emitText(cb,'Ready to integrate generated code.');}
  });
  await f.loop.load('test');f.loop.setOptions({reasoningEffort:'medium'});assert((await f.loop.send('请构建一个可交互的 3D 结构')).ok);
  assert.equal(workers,2);assert.equal(f.writes.length,0);assert.equal(f.versions.length,2);
  assert.equal(f.loop.getState().usage.total_tokens,30);
  const turn=f.saved.at(-1).body.messages.find(m=>m.role==='user');assert.equal(turn.parallelRuns[0].status,'complete');assert.equal(turn.parallelRuns[0].workers[0].content,'Complete geometry code');
});

test('Extreme effort parallel tasks route concurrently to configured design, implementation and review models, then inspect integrated state',async()=>{
  let started=0,release;const ready=new Promise(r=>release=r),seen=new Set();let main=0;
  const tasks=['design','implement','review'].map(role=>({id:role,role,task:`Produce independent ${role} artifact with concrete code/evidence`}));
  const f=teamFixture(async(p,cb)=>{
    if(p.sessionId.includes(':parallel:')){seen.add(p.model);if(++started===3)release();await ready;emitText(cb,`${p.model} artifact`);return;}
    main++;
    const actions=[()=>parallelCall(cb,tasks),()=>teamTransfer(cb,'implement','Integrate worker code'),()=>toolReply(cb),()=>teamTransfer(cb,'review','Inspect integrated code'),()=>teamCall(cb,'deck_get_state'),()=>teamTransfer(cb,'complete','Read actual integrated state after writes'),()=>emitText(cb,'Integrated and independently checked')];
    actions[main-1]();
  });
  await f.loop.load('test');f.loop.setOptions({reasoningEffort:'xhigh'});assert((await f.loop.send('构建 3D 分子结构')).ok);
  assert.deepEqual([...seen].sort(),['design','implement','review']);assert.equal(f.writes.length,1);assert.equal(f.versions.length,2);
  assert.equal(f.loop.messages.find(m=>m.role==='user').collaboration.phase,'done');
});

test('Stopping parallel workers preserves completed artifacts; reload and resume only restart unfinished tasks with their original models',async()=>{
  let partialReady;const waiting=new Promise(r=>partialReady=r),counts={geometry:0,interaction:0};let first=true;
  const f=fixture(async(p,cb,signal)=>{
    if(p.sessionId.includes(':parallel:')){
      assert.equal(p.model,'test');const id=p.sessionId.split(':').at(-1);counts[id]++;
      if(id==='geometry'){emitText(cb,'Finished geometry artifact');return;}
      if(first){first=false;cb({type:'delta',content:'Interaction prefix, '});partialReady();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('stop','AbortError')),{once:true}));}
      else {assert(p.messages.some(m=>m.role==='assistant'&&m.content==='Interaction prefix, '));emitText(cb,'continued interaction artifact');}return;
    }
    if(!p.messages.some(m=>m.role==='tool'&&m.content.includes('batchId')))parallelCall(cb);else emitText(cb,'Completed after resume');
  });
  await f.loop.load('test');const run=f.loop.send('Create a 3D molecule');await waiting;
  while(f.loop.messages.find(m=>m.role==='user')?.parallelRuns?.[0]?.workers[0]?.status!=='complete')await new Promise(r=>setTimeout(r,1));
  f.loop.stop();assert(!(await run).ok);const saved=f.saved.at(-1).body;
  assert.equal(saved.messages[0].parallelRuns[0].workers[0].status,'complete');assert.equal(saved.messages[0].parallelRuns[0].workers[1].status,'stopped');
  f.ctx.api.getChat=async()=>saved;await f.loop.load('test','default',{discardCurrent:true});
  f.snapshot.settings.providers[0].models.push({id:'other'});f.loop.setProvider('test','other');
  assert((await f.loop.resume()).ok);assert.deepEqual(counts,{geometry:1,interaction:2});
  const batch=f.loop.messages.find(m=>m.role==='user').parallelRuns[0];assert.equal(batch.workers[1].content,'Interaction prefix, continued interaction artifact');
  assert.equal(JSON.parse(f.loop.messages.find(m=>m.name==='agent_parallel').content).ok,true);
  assert.deepEqual(sanitizeConversation(f.loop.messages).map(m=>m.role),f.loop.messages.map(m=>m.role));
});

test('Parallel artifacts continue across output limits and cache successful siblings when a failed task is retried',async()=>{
  const counts={geometry:0,interaction:0};let lead=0;
  const f=fixture(async(p,cb)=>{
    if(p.sessionId.includes(':parallel:')){
      const id=p.sessionId.split(':').at(-1),n=++counts[id];
      if(id==='geometry')emitText(cb,n===1?'Code prefix, ':'code tail',n===1?'length':'stop');
      else if(n===1){const error=new Error('Invalid model');error.status=400;throw error;}else emitText(cb,'Recovered interaction');return;
    }
    if(++lead<3)parallelCall(cb);else emitText(cb,'All outputs retained and ready');
  });
  await f.loop.load('test');const sent=await f.loop.send('Build a 3D structure');assert(sent.ok,JSON.stringify(f.hooks.errors));
  assert.deepEqual(counts,{geometry:2,interaction:2});assert.equal(f.loop.messages[0].parallelRuns.length,1);
  const result=JSON.parse(f.loop.messages.filter(m=>m.name==='agent_parallel').at(-1).content);
  assert(result.ok);assert.equal(result.workers[0].content,'Code prefix, code tail');assert.equal(result.workers[1].content,'Recovered interaction');
});

test('3D explanation and opt-out do not force parallel generation, while a read-only authoring request cannot start project writes',async()=>{
  for(const text of ['什么是 3D 结构？','Explain three.js','解释如何构建 3D 结构','How do I build a 3D scene?','不要 3D，只制作二维示意图','不用三维模型'])assert.equal(needsParallel3D(text),false,text);
  assert(needsParallel3D('Create a 3D structure'));
  assert(needsParallel3D('不要固定目录，构建 3D 结构'));
  const f=fixture(async(p,cb)=>{assert.notEqual(p.toolChoice?.function?.name,'agent_parallel');emitText(cb,'Read-only analysis');});
  await f.loop.load('test');f.loop.setOptions({permission:'read'});assert((await f.loop.send('构建 3D 模型')).ok);
});

test('Background workers do not block lead writes; final delivery joins and re-enters integration with full artifacts', {timeout:5000},async()=>{
  let release,lead=0;const written=new Promise(r=>release=r),events=[],started=[];
  const f=checkpointFixture(async(p,cb)=>{
    if(p.sessionId.includes(':parallel:')){
      const id=p.sessionId.split(':').at(-1);started.push(id);await written;await new Promise(r=>setTimeout(r,25));
      events.push('worker-'+id);emitText(cb,id+' complete code');return;
    }
    lead++;
    if(lead===1){parallelCall(cb);return;}
    if(lead===2){events.push('lead-independent-request');toolReply(cb);return;}
    if(lead===3){events.push('early-delivery');emitText(cb,'Independent layout is done.');return;}
    const dispatch=JSON.parse(p.messages.find(m=>m.role==='tool'&&m.content.includes('batchId')).content);
    events.push('integrate-'+dispatch.complete);emitText(cb,'Integrated complete worker artifacts and checked the result.');
  });
  const write=f.ctx.bus.runCommand;
  f.ctx.bus.runCommand=async(name)=>{events.push('lead-write');const result=await write(name);release();return result;};
  await f.loop.load('test');const result=await f.loop.send('Build a 3D structure with title');
  assert(result.ok);assert.equal(started.length,2);assert.equal(f.writes.length,1);assert.equal(f.versions.length,2);
  assert(events.indexOf('lead-write')<events.indexOf('worker-geometry'));assert(events.indexOf('early-delivery')<events.indexOf('worker-interaction'));
  assert.equal(events.at(-1),'integrate-true');assert.equal(lead,4);assert.deepEqual(f.hooks.errors,[]);
});

test('A dependency wait collects one required artifact while the lead and other worker keep working; redispatch never duplicates running tasks', {timeout:5000},async()=>{
  let releaseSlow,lead=0;const slowGate=new Promise(r=>releaseSlow=r),starts=[],observations=[];
  const f=checkpointFixture(async(p,cb)=>{
    if(p.sessionId.includes(':parallel:')){
      const id=p.sessionId.split(':').at(-1);starts.push(id);
      if(id==='interaction')await slowGate;else await new Promise(r=>setTimeout(r,20));
      emitText(cb,id+' artifact');return;
    }
    lead++;
    const dispatch=p.messages.findLast(m=>m.role==='tool'&&m.content.includes('batchId'));
    const batchId=dispatch?JSON.parse(dispatch.content).batchId:undefined;
    if(lead===1||lead===2){parallelCall(cb);return;}
    if(lead===3){teamCall(cb,'agent_wait',{batchId,taskIds:['geometry']});return;}
    if(lead===4){const result=JSON.parse(p.messages.findLast(m=>m.role==='tool').content);observations.push(result);toolReply(cb);return;}
    if(lead===5){teamCall(cb,'agent_wait',{batchId});return;}
    emitText(cb,'Collected and integrated both artifacts.');
  });
  const write=f.ctx.bus.runCommand;f.ctx.bus.runCommand=async(name)=>{const result=await write(name);releaseSlow();return result;};
  await f.loop.load('test');assert((await f.loop.send('Build a 3D structure')).ok);
  assert.deepEqual(starts.sort(),['geometry','interaction']);assert.equal(observations[0].complete,true);assert.equal(observations[0].timedOut,false);
  assert.equal(observations[0].batches[0].workers.find(w=>w.id==='interaction').status,'running');
  assert.equal(f.writes.length,1);assert.equal(f.loop.messages[0].parallelRuns.length,1);
  assert(f.loop.messages.filter(m=>m.name==='agent_parallel').every(m=>JSON.parse(m.content).complete));
});

test('Non-blocking status, bounded wait timeouts and invalid dependency IDs leave background tasks intact', {timeout:5000},async()=>{
  let lead=0,release;const gate=new Promise(r=>release=r),results=[];
  const f=checkpointFixture(async(p,cb)=>{
    if(p.sessionId.includes(':parallel:')){await gate;emitText(cb,'Complete artifact');return;}
    lead++;
    if(lead===1){parallelCall(cb);return;}
    const batchId=JSON.parse(p.messages.find(m=>m.role==='tool'&&m.content.includes('batchId')).content).batchId;
    if(lead>2)results.push(JSON.parse(p.messages.findLast(m=>m.role==='tool').content));
    if(lead===2)teamCall(cb,'agent_parallel_status',{batchId});
    else if(lead===3)teamCall(cb,'agent_wait',{batchId,timeoutMs:0});
    else if(lead===4)teamCall(cb,'agent_wait',{batchId,taskIds:['missing']});
    else if(lead===5)teamCall(cb,'agent_wait',{batchId,timeoutMs:-1});
    else if(lead===6)teamCall(cb,'agent_parallel_status',{batchId:'missing'});
    else if(lead===7)toolReply(cb);
    else if(lead===8)teamCall(cb,'agent_wait',{batchId});
    else emitText(cb,'All results available.');
  });
  const write=f.ctx.bus.runCommand;f.ctx.bus.runCommand=async(name)=>{const result=await write(name);release();return result;};
  await f.loop.load('test');assert((await f.loop.send('Build a 3D structure')).ok);
  assert.equal(results[0].status,'running');assert.equal(results[0].ok,true);assert.equal(results[1].timedOut,true);assert.equal(results[1].ok,true);
  assert(results.slice(2,5).every(r=>r.ok===false));assert.equal(results.at(-1).complete,true);
});

test('Failed background output cannot become a completed delivery, and resume reuses successful artifacts and lead writes', {timeout:5000},async()=>{
  let retried=false;const counts={geometry:0,interaction:0};
  const f=checkpointFixture(async(p,cb)=>{
    if(p.sessionId.includes(':parallel:')){
      const id=p.sessionId.split(':').at(-1);counts[id]++;
      if(id==='interaction'&&!retried){const e=new Error('Worker rejected');e.status=400;throw e;}
      emitText(cb,id+' complete code');return;
    }
    if(!p.messages.some(m=>m.role==='tool'&&m.content.includes('batchId')))parallelCall(cb);
    else if(!f.writes.length)toolReply(cb);
    else emitText(cb,'Ready.');
  });
  await f.loop.load('test');assert.equal((await f.loop.send('Build a 3D structure')).ok,false);
  assert.equal(f.writes.length,1);assert(f.loop.messages[0].parallelRuns[0].workers.some(w=>w.status==='error'));
  retried=true;assert((await f.loop.resume()).ok);assert.deepEqual(counts,{geometry:1,interaction:2});assert.equal(f.writes.length,1);
});

test('Lead requests can run during worker inspection, but actual editor reads and writes share one short operation queue', {timeout:5000},async()=>{
  let releaseRead,readStarted,lead=0,reading=false;const allowRead=new Promise(r=>releaseRead=r),inspecting=new Promise(r=>readStarted=r),events=[],overlaps=[];
  const f=checkpointFixture(async(p,cb)=>{
    if(p.sessionId.includes(':parallel:')){
      if(p.sessionId.endsWith(':geometry')&&!p.messages.some(m=>m.role==='tool')){await allowRead;teamCall(cb,'deck_read_slide',{index:0});}
      else emitText(cb,'Complete inspected artifact');return;
    }
    lead++;
    if(lead===1){parallelCall(cb);return;}
    if(lead===2){releaseRead();await inspecting;events.push('lead-request-during-read');toolReply(cb);return;}
    emitText(cb,'Integrated and inspected.');
  });
  f.ctx.getEditor=()=>({bridge:{call:async(method)=>{
    if(method==='getSlideHtml'){reading=true;events.push('read-start');readStarted();await new Promise(r=>setTimeout(r,25));reading=false;events.push('read-end');return {html:'<div>Current slide</div>',css:'body{}'};}
    return {current:0,slides:[{id:'slide-1'}],total:1};
  }}});
  const write=f.ctx.bus.runCommand;f.ctx.bus.runCommand=async(name)=>{overlaps.push(reading);events.push('write');return write(name);};
  await f.loop.load('test');assert((await f.loop.send('Build a 3D structure')).ok);
  assert.deepEqual(overlaps,[false]);assert(events.indexOf('read-start')<events.indexOf('lead-request-during-read'));
  assert(events.indexOf('lead-request-during-read')<events.indexOf('read-end'));assert(events.indexOf('read-end')<events.indexOf('write'));
});

test('Artifacts finishing during a lead response trigger another integration request before final delivery', {timeout:5000},async()=>{
  let releaseWorkers,allFinished,lead=0,count=0;const gate=new Promise(r=>releaseWorkers=r),finished=new Promise(r=>allFinished=r);
  const f=fixture(async(p,cb)=>{
    if(p.sessionId.includes(':parallel:')){await gate;emitText(cb,'Full artifact');if(++count===2)allFinished();return;}
    lead++;
    if(lead===1){parallelCall(cb);return;}
    if(lead===2){releaseWorkers();await finished;emitText(cb,'Premature completion using previous snapshot');return;}
    emitText(cb,'Collected all new results and integrated them.');
  });
  await f.loop.load('test');assert((await f.loop.send('Build a 3D structure')).ok);
  assert.equal(lead,3);assert.equal(f.loop.messages.at(-1).content,'Collected all new results and integrated them.');
});

test('Role handoff permits independent implementation in the background but gates final review on collected worker artifacts', {timeout:5000},async()=>{
  let release,lead=0;const gate=new Promise(r=>release=r);
  const f=teamFixture(async(p,cb)=>{
    if(p.sessionId.includes(':parallel:')){await gate;emitText(cb,'Complete worker artifact');return;}
    const actions=[()=>parallelCall(cb),()=>teamTransfer(cb,'implement'),()=>teamTransfer(cb,'review'),()=>toolReply(cb),
      ()=>teamCall(cb,'agent_wait'),()=>teamTransfer(cb,'review'),()=>teamCall(cb,'deck_get_state'),()=>teamTransfer(cb,'complete'),()=>emitText(cb,'Delivered after integration and review.')];
    actions[lead++]();
  });
  const write=f.ctx.bus.runCommand;f.ctx.bus.runCommand=async(name)=>{const result=await write(name);release();return result;};
  await f.loop.load('test');f.loop.setOptions({reasoningEffort:'xhigh'});assert((await f.loop.send('Build a 3D structure')).ok);
  const transfers=f.loop.messages.filter(m=>m.name==='agent_handoff').map(m=>JSON.parse(m.content));
  assert.equal(transfers[0].to,'implement');assert.equal(transfers[1].ok,false);assert(transfers[1].error.includes('agent_wait'));
  assert.equal(transfers[2].to,'review');assert.equal(transfers[3].to,'final');assert.equal(f.writes.length,1);
});

test('Stop cancels both a running lead request and background workers before a new chat can start', {timeout:5000},async()=>{
  let leadReady,lead=0;const ready=new Promise(r=>leadReady=r),cancelled=[];
  const blocked=(signal,id)=>new Promise((resolve,reject)=>{
    const cancel=()=>{cancelled.push(id);reject(new DOMException('stop','AbortError'));};
    if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
  });
  const f=fixture(async(p,cb,signal)=>{
    if(p.sessionId.includes(':parallel:')){const id=p.sessionId.split(':').at(-1);cb({type:'delta',content:id+' partial output'});await blocked(signal,id);return;}
    if(++lead===1){parallelCall(cb);return;}
    cb({type:'delta',content:'Independent lead progress'});leadReady();await blocked(signal,'lead');
  });
  await f.loop.load('test');const running=f.loop.send('Build a 3D structure');await ready;f.loop.stop();assert.equal((await running).ok,false);
  assert.deepEqual(cancelled.sort(),['geometry','interaction','lead']);
  const previous=f.saved.at(-1).body;assert(previous.messages[0].parallelRuns[0].workers.every(w=>w.status==='stopped'&&w.content.includes('partial output')));
  await f.loop.newChat();assert.equal(f.loop.messages.length,0);assert.equal(f.loop.streaming,false);
});

test('Extreme effort uses three configured models, reviews real state and returns to the design model for delivery',async()=>{
  const f=teamFixture(async(p,cb,signal,n)=>{
    if(n===1){assert.equal(p.model,'design');emitText(cb,'设计：统一布局并拆分实现任务。');}
    if(n===2){assert.equal(p.model,'implement');assert.equal(p.maxTokens,16000);toolReply(cb);}
    if(n===3){assert.equal(p.model,'implement');teamTransfer(cb,'review','实现已写入，检查标题尺寸与布局');}
    if(n===4){assert.equal(p.model,'review');assert(!p.tools.some(t=>t.function.name==='deck_set_text'));teamCall(cb,'deck_get_state');}
    if(n===5){assert.equal(p.model,'review');teamTransfer(cb,'complete','根据真实状态完成检查');}
    if(n===6){assert.equal(p.model,'design');emitText(cb,'最终交付完成。');}
  });
  await f.loop.load('test');f.loop.setOptions({reasoningEffort:'xhigh'});assert((await f.loop.send('完成页面')).ok);
  assert.equal(f.requests.length,6);assert.equal(f.writes.length,1);assert.equal(f.versions.length,2);
  assert(f.requests.every(r=>r.reasoning_effort!=='xhigh'));assert.equal(f.loop.messages.find(m=>m.role==='user').collaboration.phase,'done');
  assert(f.saved.at(-1).body.messages.some(m=>m.agentRole?.role==='review'));assert.equal(f.saved.at(-1).body.messages.at(-1).content,'最终交付完成。');
});

test('Reviewer can reject implementation and design, and all repairs share the original turn checkpoint',async()=>{
  const f=teamFixture(async(p,cb,signal,n)=>{
    const actions=[()=>teamTransfer(cb,'implement'),()=>toolReply(cb),()=>teamTransfer(cb,'review'),()=>teamCall(cb,'deck_get_state'),()=>teamTransfer(cb,'design','视觉层级需要重新设计'),()=>teamTransfer(cb,'implement','修复设计中的标题比例'),()=>toolReply(cb,['insert.shape']),()=>teamTransfer(cb,'review'),()=>teamCall(cb,'deck_get_state'),()=>teamTransfer(cb,'implement','边距仍需修复'),()=>teamTransfer(cb,'review'),()=>teamCall(cb,'deck_get_state'),()=>teamTransfer(cb,'complete','已核对修复结果'),()=>emitText(cb,'完成两次修订')];
    actions[n-1]();
  });
  await f.loop.load('test');f.loop.setOptions({reasoningEffort:'xhigh'});assert((await f.loop.send('协作修复')).ok);
  assert.equal(f.writes.length,2);assert.equal(f.versions.length,2);assert.equal(f.loop.messages[0].collaboration.revisions,2);
  assert.deepEqual(f.requests.map(r=>r.model),['design','implement','implement','review','review','design','implement','implement','review','review','implement','review','review','design']);
});

test('Reviewer cannot mutate through a nested dispatcher or approve without inspecting real state',async()=>{
  const f=teamFixture(async(p,cb,signal,n)=>{
    if(n===1)teamTransfer(cb,'implement');if(n===2)teamTransfer(cb,'review');
    if(n===3)teamCall(cb,'app_run_command',{name:'insert.text'});
    if(n===4){assert.equal(JSON.parse(p.messages.findLast(m=>m.role==='tool').content).ok,false);teamTransfer(cb,'complete');}
    if(n===5){assert.equal(JSON.parse(p.messages.findLast(m=>m.role==='tool').content).ok,false);teamCall(cb,'deck_get_state');}
    if(n===6)teamTransfer(cb,'complete');if(n===7)emitText(cb,'检查完成');
  });
  await f.loop.load('test');f.loop.setOptions({reasoningEffort:'xhigh'});assert((await f.loop.send('只读审查')).ok);
  assert.equal(f.writes.length,0);assert.equal(f.versions.length,2);
});

test('Interrupted worker resumes with its configured model and never repeats a successful mutation',async()=>{
  let paused;
  const waiting=new Promise(r=>paused=r);
  const f=teamFixture(async(p,cb,signal,n)=>{
    if(n===1)teamTransfer(cb,'implement');if(n===2)toolReply(cb);
    if(n===3){paused();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('stop','AbortError')),{once:true}));}
    if(n===4){assert.equal(p.model,'implement');teamTransfer(cb,'review');}
    if(n===5)teamCall(cb,'deck_get_state');if(n===6)teamTransfer(cb,'complete');if(n===7)emitText(cb,'续接完成');
  });
  await f.loop.load('test');f.loop.setOptions({reasoningEffort:'xhigh'});const run=f.loop.send('实现后检查');await waiting;f.loop.stop();assert(!(await run).ok);
  const saved=f.saved.at(-1).body;assert.equal(saved.messages.find(m=>m.role==='user').collaboration.phase,'implement');
  f.ctx.api.getChat=async()=>saved;await f.loop.load('test','default',{discardCurrent:true});
  assert((await f.loop.resume()).ok);assert.equal(f.writes.length,1);assert.equal(f.loop.messages.at(-1).content,'续接完成');
});

test('Unknown configured role model blocks execution before creating a user turn',async()=>{
  const f=teamFixture(async()=>assert.fail('must not request'));
  f.snapshot.settings.agent.collaboration.review.providerId='missing-provider';
  await f.loop.load('test');f.loop.setOptions({reasoningEffort:'xhigh'});assert(!(await f.loop.send('执行')).ok);assert.equal(f.loop.messages.length,0);
});

test('Explicit role configuration starts without a default chat model and resumes independently of chat selection',async()=>{
  let paused;const waiting=new Promise(r=>paused=r);
  const f=teamFixture(async(p,cb,signal,n)=>{
    if(n===1){assert.equal(p.model,'design');teamTransfer(cb,'implement');}
    if(n===2){assert.equal(p.model,'implement');paused();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('stop','AbortError')),{once:true}));}
    if(n===3){assert.equal(p.model,'implement');teamTransfer(cb,'review');}
    if(n===4)teamCall(cb,'deck_get_state');
    if(n===5)teamTransfer(cb,'complete');
    if(n===6)emitText(cb,'使用保存的协作配置完成');
  });
  f.snapshot.settings.providers[0].model='';f.snapshot.settings.providers[0].models=[];
  await f.loop.load('test');f.loop.setOptions({reasoningEffort:'xhigh'});
  const run=f.loop.send('配置了三个角色但没有普通聊天模型');
  assert(await Promise.race([waiting.then(()=>true),run.then(()=>false)]),'must start the configured roles');
  f.loop.stop();await run;
  f.loop.setOptions({reasoningEffort:'medium'});
  assert((await f.loop.resume()).ok);assert.equal(f.requests.length,6);
});

test('A text-only reviewer is prompted to read state and then forced to hand off instead of looping',async()=>{
  const f=teamFixture(async(p,cb,signal,n)=>{
    if(n===1)emitText(cb,'设计完成，任务交给实现。');
    if(n===2)emitText(cb,'实现阶段说明。');
    if(n===3)emitText(cb,'我认为已经完成。');
    if(n===4){assert.equal(p.toolChoice?.function?.name,'deck_get_state');teamCall(cb,'deck_get_state');}
    if(n===5)emitText(cb,'已经读取工程，核对完成。');
    if(n===6){assert.equal(p.toolChoice?.function?.name,'agent_handoff');teamTransfer(cb,'complete','根据实际读取结果通过检查');}
    if(n===7)emitText(cb,'三角色最终交付');
  });
  await f.loop.load('test');f.loop.setOptions({reasoningEffort:'xhigh'});assert((await f.loop.send('完成并检查')).ok);
  assert.equal(f.requests.length,7);
});

test('A reviewer that cannot call tools pauses promptly and does not claim a completed collaboration',async()=>{
  const f=teamFixture(async(p,cb)=>emitText(cb,'仅输出文字，不调用工具。'));
  await f.loop.load('test');f.loop.setOptions({reasoningEffort:'xhigh'});assert(!(await f.loop.send('实际检查')).ok);
  assert(f.requests.length<=6);assert.equal(f.loop.messages.find(m=>m.collaboration).collaboration.phase,'review');
  assert(f.hooks.errors.at(-1).message.includes('检查'));
});

test('An explicitly tool-incompatible role is rejected before starting the collaboration',async()=>{
  const f=teamFixture(async()=>assert.fail('must not request'));
  f.snapshot.settings.providers[0].models.find(m=>m.id==='implement').tools=false;
  await f.loop.load('test');f.loop.setOptions({reasoningEffort:'xhigh'});assert(!(await f.loop.send('实现')).ok);
  assert.equal(f.loop.messages.length,0);
});

test('Fresh conversations enable the three requested skills; explicit custom choices survive reload and disk persistence', async () => {
  const expected = ['deck-narrative','html-deck-craft','motion-design'];
  assert.deepEqual(initialSkillIds(FALLBACK_SKILLS, { skills: [], updatedAt: 0 }).sort(), expected);
  assert.deepEqual(initialSkillIds(FALLBACK_SKILLS, { skills: ['motion-design','layout-typography','html-deck-craft'] }).sort(), expected);
  assert.deepEqual(initialSkillIds(FALLBACK_SKILLS, { skills: [], skillsPolicy: 2, skillsCustomized: true }), []);
  const f = fixture(async (_, cb) => emitText(cb, 'ok'));
  f.ctx.api.getChat = async () => ({ messages: [], skills: [], updatedAt: 0 });
  await f.loop.load('test'); assert.deepEqual([...f.loop.skills].sort(), expected);
  f.loop.setSkills([]); await f.loop.flush(); const saved = f.saved.at(-1).body;
  assert.equal(saved.skillsCustomized, true); assert.equal(saved.skillsPolicy, 2);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wds-skills-'));
  try {
    await saveChat(root, 'default', saved); const disk = await readChat(root, 'default');
    f.ctx.api.getChat = async () => disk; await f.loop.load('test', 'default', { discardCurrent: true });
    assert.deepEqual(f.loop.skills, []); assert.equal(disk.skillsCustomized, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Context breakdown adds up exactly and uses the model window, while permission and model switches refresh it', async () => {
  const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }];
  const usage = contextUsage(messages, [{ function: { name: 'tool' } }], { limit: 1000, budget: 600 });
  assert.equal(Object.values(usage.breakdown).reduce((a,b) => a+b,0), usage.tokens);
  assert.equal(usage.percent, Math.round(usage.tokens / 1000 * 100)); assert(usage.breakdown.tools > 0);
  const f = fixture(async (_, cb) => emitText(cb, '回复'));
  await f.loop.load('test'); const initial = f.loop.getState().context;
  assert(initial.breakdown.system > 0); assert(initial.breakdown.tools > 0);
  f.loop.setOptions({ permission: 'read' }); assert(f.loop.getState().context.breakdown.tools < initial.breakdown.tools);
  f.snapshot.settings.providers[0].models.push({ id: 'large', contextLength: 1000000 });
  f.snapshot.settings.agent.contextLimit = 1000000; f.loop.setProvider('test', 'large');
  assert.equal(f.loop.getState().context.limit, 1000000);
  await f.loop.send('新消息'); assert(f.loop.getState().context.breakdown.messages > 0);
});
test('Mutating turns capture a single before checkpoint and a complete after checkpoint, including durable turn links', async () => {
  const old = [{ role: 'user', content: '旧请求' }, { role: 'assistant', content: '旧回复' }];
  const f = checkpointFixture(async (_, cb, signal, n) => n === 1 ? toolReply(cb, ['insert.text', 'insert.shape']) : emitText(cb, '完成修改'), old);
  await f.loop.load('test'); await f.loop.send('改成蓝色');
  assert.equal(f.versions.length, 2); assert.equal(f.writes.length, 2); assert(f.writes.every((w) => w.snapshotsBeforeWrite === 1));
  assert.deepEqual(f.versions[0].options.chat.messages.map(({ role, content }) => ({ role, content })), old); assert.equal(f.versions[0].options.chat.summary, null);
  assert(f.versions[0].options.chat.messages[0].turnId, 'Legacy turns acquire durable IDs on load');
  assert.equal(f.versions[1].options.chat.messages.at(-1).content, '完成修改');
  assert.equal(f.versions[1].options.chat.messages.filter((m) => m.role === 'tool').length, 2);
  const user = f.saved.at(-1).body.messages.find((m) => m.content === '改成蓝色');
  assert.equal(user.versions.test.before, 'version-0'); assert.equal(user.versions.test.after, 'version-1'); assert.equal(user.versions.test.pending, undefined);
  assert.equal(user.deliveries[0].versionId,'version-1');assert.equal(user.deliveries[0].status,'complete');
});
test('Read-only turns keep conversation snapshots while denied API calls create no mutation checkpoints', async () => {
  const f = checkpointFixture(async (_, cb) => emitText(cb, '仅建议，不修改'));
  await f.loop.load('test'); await f.loop.send('先分析'); assert.equal(f.versions.length, 2);
  let checkpoints = 0;
  const result = await createToolExecutor(f.ctx).execute('app_call_api', { operation: 'files.write', body: { content: 'x' } }, { permission: 'read', beforeMutation: async () => { checkpoints++; } });
  assert.equal(result.ok, false); assert.equal(checkpoints, 0);
  assert.equal(mutationProject(f.ctx, 'app_call_api', { operation: 'timeline.write', projectId: 'other' }), 'other');
  assert.equal(mutationProject(f.ctx, 'app_call_api', { operation: 'settings.write' }), null);
  assert.equal(mutationProject(f.ctx, 'app_call_api', { operation: 'models.list' }), null);
});
test('A checkpoint failure blocks the project write and remains visible in the actual tool result', async () => {
  const f = checkpointFixture(async (_, cb, signal, n) => n === 1 ? toolReply(cb) : emitText(cb, '版本保存失败，未执行修改'));
  f.ctx.api.createVersion = async () => { throw new Error('磁盘空间不足'); };
  await f.loop.load('test'); await f.loop.send('修改');
  assert.equal(f.writes.length, 0);
  const result = JSON.parse(f.loop.messages.find((m) => m.role === 'tool').content);
  assert.equal(result.ok, false); assert.match(result.error, /磁盘空间不足/);
});
test('Stop and resume preserve the original before version and create new after versions without replaying writes', async () => {
  const f = checkpointFixture(async (_, cb, signal, n) => {
    if (n === 1 || n === 3) return toolReply(cb);
    if (n === 2) {
      cb({ type: 'delta', content: '已经完成第一项。' });
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('stop', 'AbortError')), { once: true }));
    } else emitText(cb, '继续完成第二项。');
  });
  await f.loop.load('test'); const pending = f.loop.send('完成两项');
  while (f.requests.length < 2) await new Promise((r) => setTimeout(r, 2));
  f.loop.stop(); await pending;
  assert.equal(f.versions.length, 2); assert.equal(f.writes.length, 1);
  await f.loop.resume();
  assert.equal(f.versions.length, 3); assert.equal(f.writes.length, 2);
  assert.equal(f.versions.filter((v) => v.options.kind === 'before').length, 1);
  assert.equal(f.loop.messages[0].versions.test.before, 'version-0'); assert.equal(f.loop.messages[0].versions.test.after, 'version-2');
});
test('Rewinding reloads the restored conversation without flushing the discarded future over it', async () => {
  const f = checkpointFixture(async (_, cb) => emitText(cb, '未来回复'));
  await f.loop.load('test'); await f.loop.send('未来请求');
  let restoreIndex;
  f.ctx.api.restoreVersion = async () => {
    restoreIndex = f.saved.length;
    f.ctx.api.getChat = async () => ({ messages: [{ role: 'user', content: '历史请求' }, { role: 'assistant', content: '历史回复' }], skills: [], summary: null });
    return { ok: true, version: { label: '历史版本' }, conversation: { sessionId: 'default', archivedSession: 'branch-history' } };
  };
  await f.loop.restoreCheckpoint('version', { rewindConversation: true });
  assert.equal(f.loop.messages.at(-1).content, '历史回复'); assert.equal(f.saved.length, restoreIndex);
  await f.loop.flush(); assert.equal(f.saved.at(-1).body.messages.at(-1).content, '历史回复');
});
test('A failed post-rewind read blocks writes until the committed snapshot can be reloaded', async () => {
  const f = checkpointFixture(async (_, cb) => emitText(cb, '未来回复'));
  await f.loop.load('test');
  await f.loop.send('未来请求');
  let restores = 0, unavailable = true;
  f.ctx.api.restoreVersion = async () => {
    restores++;
    f.ctx.api.getChat = async () => {
      if (unavailable) throw new Error('Connection lost');
      return { messages: [{ role: 'user', content: '历史请求' }], skills: [] };
    };
    return { ok: true, conversation: { sessionId: 'default' } };
  };
  const result = await f.loop.restoreCheckpoint('version', { rewindConversation: true });
  assert(result.conversationError);
  assert.equal(f.loop.messages.at(-1).content, '未来回复');
  assert.equal(f.hooks.errors.at(-1).retryLoad, true);
  const saves = f.saved.length;
  await f.loop.flush();
  assert.equal((await f.loop.send('不得写回旧会话')).ok, false);
  assert.equal(f.saved.length, saves);
  unavailable = false;
  assert.equal(await f.loop.resume(), true);
  assert.equal(f.loop.messages.at(-1).content, '历史请求');
  assert.equal(restores, 1);
});
test('Resume finalizes a pending checkpoint after browser interruption even if no additional writes are needed', async () => {
  const f = checkpointFixture(async (_, cb) => emitText(cb, '确认当前状态，已完成'), [
    { role: 'user', content: '中断前请求', turnId: 'interrupted', versions: { test: { before: 'original-before', pending: true } } },
    { role: 'assistant', content: '中断前的进度', incomplete: true },
  ]);
  await f.loop.load('test'); await f.loop.resume();
  assert.equal(f.versions.length, 1); assert.equal(f.versions[0].options.kind, 'after');
  assert.equal(f.loop.messages[0].versions.test.before, 'original-before'); assert.equal(f.loop.messages[0].versions.test.after, 'version-0');
  assert.equal(f.loop.messages[0].versions.test.pending, undefined);
});
test('SSE preserves fragmented Unicode, CRLF, multiline events and final unterminated frame', async () => {
  const bytes = new TextEncoder().encode(': pulse\r\nevent: message\r\ndata: {"text":\r\ndata: "你好 🌱"}\r\n\r\ndata: {"last":true}');
  const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close(); } });
  const events = []; for await (const event of readSSE(body)) events.push(event);
  assert.equal(JSON.parse(events[0].data).text, '你好 🌱'); assert.equal(JSON.parse(events[1].data).last, true);
});
test('Conversation store retains more than 200 messages and separate sessions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webdeck-chat-test-'));
  try {
    const messages = Array.from({ length: 412 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '消息' + i }));
    await saveChat(dir, 'default', { messages }); await saveChat(dir, 'another', { messages: [{ role: 'user', content: '独立会话' }] });
    assert.equal((await readChat(dir)).messages.length, 412); assert.equal((await listChats(dir)).chats.length, 2);
    await assert.rejects(() => saveChat(dir, '../escape', {}), /会话 ID/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('Long conversation retains the first user preference beyond the old 12-message limit', async () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i === 0 ? '记住：品牌色使用蓝色，禁止暖色' : '第' + i + '条消息' }));
  const f = fixture(async (_, cb) => emitText(cb, '继续沿用蓝色。'), history);
  await f.loop.load('test'); await f.loop.send('接着做');
  assert(f.requests[0].messages.some((m) => String(m.content).includes('品牌色使用蓝色')));
  assert.equal(f.loop.messages.length, 32);
});
test('Length continuations combine into one complete assistant message without synthetic user turns', async () => {
  const parts = ['第一段：开始。', '第二段：继续。', '第三段：完成。'];
  const f = fixture(async (_, cb, signal, n) => emitText(cb, parts[n - 1], n < 3 ? 'length' : 'stop'));
  await f.loop.load('test'); const result = await f.loop.send('写三段');
  assert.equal(result.ok, true); assert.equal(f.loop.messages.filter((m) => m.role === 'assistant').length, 1);
  assert.equal(f.loop.messages.at(-1).content, parts.join('')); assert.equal(f.loop.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(f.saved.at(-1).body.messages.at(-1).incomplete, false);
});
test('Unexpected EOF reconnects and preserves the partial response', async () => {
  const f = fixture(async (_, cb, signal, n) => { if (n === 1) cb({ type: 'delta', content: '保留前半段。' }); else emitText(cb, '接着完成后半段。'); });
  await f.loop.load('test'); await f.loop.send('断流测试');
  assert.equal(f.requests.length, 2); assert.equal(f.loop.messages.at(-1).content, '保留前半段。接着完成后半段。');
});
test('Provider errors remain errors and keep partial output for explicit resume', async () => {
  const f = fixture(async (_, cb) => { cb({ type: 'delta', content: '保留下来的进度' }); cb({ type: 'error', status: 401, recoverable: false, message: '密钥无效' }); });
  await f.loop.load('test'); const r = await f.loop.send('测试');
  assert.equal(r.ok, false); assert.equal(f.requests.length, 1); assert.equal(f.hooks.errors[0].message, '密钥无效');
  assert.equal(f.loop.messages.at(-1).content, '保留下来的进度'); assert.equal(f.loop.messages.at(-1).incomplete, true);
});
test('Tool JSON failure is repaired without executing partial write arguments', async () => {
  let writes = 0;
  const f = fixture(async (_, cb, signal, n) => {
    if (n === 1) { cb({ type: 'tool_calls', snapshot: true, tool_calls: [{ id: 'partial', type: 'function', function: { name: 'file_write', arguments: '{"path":"index.html","content":"' } }] }); cb({ type: 'done', finish_reason: 'length' }); }
    else emitText(cb, '已改为小步处理。');
  });
  f.ctx.api.putFile = async () => { writes++; };
  await f.loop.load('test'); await f.loop.send('修改文件');
  assert.equal(writes, 0); assert.equal(f.requests.length, 2); assert(!f.loop.messages.some((m) => m.tool_calls?.length));
});
test('Tool results larger than 2400 characters reach subsequent requests without hard truncation', async () => {
  const f = fixture(async (payload, cb, signal, n) => {
    if (n === 1) { cb({ type: 'tool_calls', tool_calls: [{ id: 'catalog', type: 'function', function: { name: 'app_list_apis', arguments: '{}' } }] }); cb({ type: 'done', finish_reason: 'tool_calls' }); }
    else emitText(cb, '已读取完整接口。');
  });
  await f.loop.load('test'); await f.loop.send('有哪些接口');
  const tool = f.requests[1].messages.find((m) => m.role === 'tool');
  assert(tool.content.length > 2400); assert(JSON.parse(tool.content).operations.some((o) => o.id === 'search.web'));
});
test('Permission restrictions apply inside API and command dispatchers', async () => {
  const f = fixture(async () => {}); const executor = createToolExecutor(f.ctx);
  const denied = await executor.execute('app_call_api', { operation: 'projects.create', body: { name: 'x' } }, { permission: 'read' });
  assert.equal(denied.ok, false);
  const command = await executor.execute('app_run_command', { name: 'file.rename' }, { permission: 'edit' });
  assert.equal(command.ok, false);
  const search = await executor.execute('app_call_api', { operation: 'search.web' }, { permission: 'full', webSearch: false });
  assert.equal(search.ok, false);
});
test('Stop retains partial output and interrupted tool calls retain explicit results', async () => {
  const f = fixture(async (_, cb, signal) => {
    cb({ type: 'delta', content: '停下也保留的正文' });
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('stop', 'AbortError')), { once: true }));
  });
  await f.loop.load('test'); const pending = f.loop.send('长任务');
  await new Promise((r) => setTimeout(r, 10)); f.loop.stop(); await pending;
  assert.equal(f.loop.messages.at(-1).content, '停下也保留的正文'); assert.equal(f.loop.messages.at(-1).aborted, true);
  const cleaned = sanitizeConversation([{ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'deck_set_text', arguments: '{}' } }] }]);
  assert.equal(cleaned[1].tool_call_id, 'x'); assert.equal(JSON.parse(cleaned[1].content).interrupted, true);
});
test('New conversations preserve and flush the existing conversation', async () => {
  const f = fixture(async (_, cb) => emitText(cb, '已完成'));
  await f.loop.load('test'); await f.loop.send('旧对话'); await f.loop.newChat();
  assert(f.saved.some((s) => s.session === 'default' && s.body.messages.some((m) => m.content === '旧对话')));
  assert.notEqual(f.loop.getState().sessionId, 'default');
});
test('Context compaction keeps real model memory and the current user turn', async () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: ('历史' + i + '。').repeat(1600) }));
  const f = fixture(async (p, cb) => emitText(cb, p.tools.length ? '根据记忆继续完成。' : '用户要求深色背景，标题保持中文。'), history, { contextLimit: 32000 });
  await f.loop.load('test'); await f.loop.send('继续这个项目');
  assert(f.requests.length > 2); assert(f.loop.getState().foldedCount > 0);
  assert(f.requests.slice(0, -1).every((r) => messageTokens(r.messages) + r.maxTokens < 32000));
  assert(f.requests.at(-1).messages.some((m) => String(m.content).includes('用户要求深色背景')));
  assert(f.requests.at(-1).messages.some((m) => m.content === '继续这个项目'));
  assert.equal(f.loop.messages.length, 22);
  assert(f.requests.every(r => r.model === 'test' && r.providerId === 'test'));
});

test('Automatic compaction reserves memory space before output for a small context window', async () => {
  const f = fixture(async (p, cb) => {
    assert(p.tools.length, 'a short fresh request does not need summarization');
    assert(p.maxTokens < 8192, 'large fixed instructions must reduce the output reservation');
    assert(messageTokens(p.messages) + estimateTokens(JSON.stringify(p.tools)) + p.maxTokens <= 32000 * .9);
    emitText(cb, '继续完成。');
  }, [], { contextLimit: 32000 });
  await f.loop.load('test');
  assert((await f.loop.send('继续制作页面')).ok);
  assert.equal(f.requests.length, 1);
  assert.equal(f.hooks.errors.length, 0);
});

test('An active generation automatically compacts between tool rounds without replaying successful changes', async () => {
  let main = 0, compacted = 0;
  const f = checkpointFixture(async (p, cb) => {
    if (!p.tools.length) { compacted++; emitText(cb, '已插入文本，保留中文标题，接着交付，不重复修改。'); return; }
    if (++main === 1) { cb({ type: 'delta', content: '已完成的设计与实现说明。'.repeat(10000) }); toolReply(cb); return; }
    assert(p.messages.some(m => m.role === 'system' && m.content.includes('已插入文本')));
    emitText(cb, '已完成交付。');
  });
  f.snapshot.settings.agent.contextLimit = 32000;
  await f.loop.load('test');
  assert((await f.loop.send('制作页面并交付')).ok);
  assert(compacted > 0); assert.equal(main, 2); assert.equal(f.writes.length, 1);
  assert(f.loop.getState().foldedCount > 0);
  assert(f.loop.messages.some(m => m.role === 'assistant' && m.content.length > 100000));
  assert.equal(f.hooks.errors.length, 0);
});

test('An upstream context error code automatically triggers compaction even with a generic message', async () => {
  let main = 0;
  const f = fixture(async (p, cb) => {
    if (!p.tools.length) { emitText(cb, '保留任务与当前进度。'); return; }
    if (++main === 1) { cb({ type: 'error', error: { code: 'context_length_exceeded', message: 'Request rejected' } }); return; }
    emitText(cb, '压缩后自动继续。');
  });
  await f.loop.load('test');
  assert((await f.loop.send('继续制作')).ok);
  assert.equal(main, 2); assert(f.loop.getState().summary); assert.equal(f.hooks.errors.length, 0);
});

test('Request byte limits compact large visual history even when token estimates fit', async () => {
  const data = 'data:image/png;base64,' + 'A'.repeat(MAX_CHAT_BYTES + 100);
  const history = [{ role: 'user', content: 'Inspect this image', images: [data] }, { role: 'assistant', content: 'Read the old image' }, { role: 'user', content: 'Continue with the layout' }];
  let compacted = 0;
  const fitted = await fitConversation({ history, prefix: [{role:'system',content:'Keep working'}], tools: [], budget: 1000000,
    render: items => items.map(m => m.images ? { role: m.role, content: [{type:'text',text:m.content},{type:'image_url',image_url:{url:m.images[0]}}] } : {role:m.role,content:m.content}),
    summarize: async () => { compacted++; return 'Keep the original layout and continue.'; } });
  assert(compacted > 0); assert(requestBytes(fitted.messages) < MAX_CHAT_BYTES);
  assert.equal(history[0].images[0], data);
  assert(fitted.messages.some(m => m.content === 'Continue with the layout'));
});

test('Compacting the current turn keeps affordable clipboard images in the model request', async () => {
  const image = 'data:image/png;base64,' + 'A'.repeat(1300000);
  const turn = { role: 'user', id: 'clipboard', content: 'Inspect this screenshot. ' + 'context '.repeat(10000), images: [image] };
  const fitted = await fitConversation({
    history: [turn], prefix: [{ role: 'system', content: 'Keep working' }], tools: [],
    budget: 14000, maxBytes: 2 * 1024 * 1024,
    render: items => items.map(m => ({ role: m.role, content: [
      { type: 'text', text: m.content }, { type: 'image_url', image_url: { url: m.images[0] } },
    ] })),
    summarize: async () => 'Inspect the attached screenshot.',
  });
  const content = fitted.messages.find(m => m.role === 'user').content;
  assert(content[0].text.includes('Inspect this screenshot.'));
  assert.equal(content[1].image_url.url, image);
  assert.equal(fitted.summary.through, 1);
});

test('HTTP 413 resumes automatically after compression without repeating completed mutations', async () => {
  let main = 0, compacted = 0;
  const f = checkpointFixture(async (p, cb) => {
    if (!p.tools.length) { compacted++; emitText(cb, 'Text was inserted successfully. Continue without repeating it.'); return; }
    if (++main === 1) { toolReply(cb); return; }
    if (main === 2) { cb({type:'error',status:413,message:'请求体过大'}); return; }
    assert(p.messages.some(m => String(m.content).includes('Text was inserted successfully')));
    emitText(cb, '完成。');
  });
  await f.loop.load('test'); assert((await f.loop.send('完成修改')).ok);
  assert.equal(f.writes.length, 1); assert(compacted > 0); assert.equal(main, 3); assert.equal(f.hooks.errors.length, 0);
});

test('The summarizer reduces its byte budget after HTTP 413 and preserves every source segment', async () => {
  const source = 'Detailed conversation record. '.repeat(100000), accepted = [], rejected = [];
  const result = await summarizeContext({ source, targetTokens: 1024,
    model: { providerId: 'memory', model: 'large-window', info: { contextLength: 10000000 } },
    request: async (payload, cb) => {
      const bytes = requestBytes(payload);
      if (bytes > 1100000) { rejected.push(bytes); throw Object.assign(new Error('请求体过大'), { status: 413 }); }
      accepted.push(payload.messages[1].content.split('【接续记录】\n')[1]);
      emitText(cb, 'Preserved goals and progress.');
    } });
  assert(rejected.length >= 2);
  assert(rejected[1] < rejected[0]);
  assert.equal(accepted.join(''), source);
  assert.equal(result, 'Preserved goals and progress.');
});

test('Compaction selection follows the active role by default and validates explicit services without requiring tools', () => {
  const providers = [{ id: 'chat', keySet: true, model: 'default-chat' }, { id: 'memory', keySet: true, model: 'small-text', models: [{ id: 'small-text', tools: false }] }];
  const active = { providerId: 'chat', model: 'active-reviewer' };
  assert.deepEqual(normalizeCompaction(null), { providerId: '', model: '' });
  assert.equal(resolveCompaction({}, active, providers, findModel).model, 'active-reviewer');
  assert.equal(resolveCompaction({ providerId: 'memory' }, active, providers, findModel).model, 'small-text');
  assert.equal(resolveCompaction({ model: 'custom-manual-id' }, active, providers, findModel).model, 'custom-manual-id');
  assert.throws(() => resolveCompaction({ providerId: 'deleted' }, active, providers, findModel), /压缩模型不可用/);
  assert.throws(() => resolveCompaction({ providerId: 'memory' }, active, [{ ...providers[1], keySet: false }], findModel), /压缩模型不可用/);
});

test('A dedicated small-window summarizer receives every history segment within its own budget and leaves the chat model unchanged', async () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: ('记录' + i + ' \\"\n🌱').repeat(1800) }));
  const segments = [];
  const f = fixture(async (p, cb) => {
    if (!p.tools.length) {
      assert.equal(p.providerId, 'memory-provider'); assert.equal(p.model, 'manual-memory');
      assert.equal(p.messages[0].content, COMPACTION_PROMPT);
      assert(messageTokens(p.messages) + p.maxTokens <= 8192 * .85);
      assert(p.maxTokens <= 512); assert(p.sessionId.endsWith(':compaction'));
      segments.push(p.messages[1].content.split('【接续记录】\n')[1]);
      cb({ type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      emitText(cb, '保留中文标题、关键文件 assets/source.svg；尚待完成布局。');
    } else {
      assert.equal(p.providerId, 'test'); assert.equal(p.model, 'test');
      assert(p.messages.some(m => String(m.content).includes('assets/source.svg')));
      emitText(cb, '继续制作。');
    }
  }, history, { contextLimit: 32000, compaction: { providerId: 'memory-provider', model: 'manual-memory' } });
  f.snapshot.settings.providers.push({ id: 'memory-provider', keySet: true, model: 'default-memory', models: [{ id: 'manual-memory', contextLength: 8192, maxOutput: 512, tools: false }] });
  await f.loop.load('test'); assert((await f.loop.send('继续，保持中文标题')).ok);
  assert(segments.length > 3);
  // No characters are discarded or repeated when the selected model needs many small segments.
  assert.equal(segments.join(''), history.map(m => `${m.role}: ${m.content}`).join('\n\n'));
  assert.equal(f.loop.messages.length, history.length + 2);
  assert.equal(f.loop.getState().summary.model, 'manual-memory');
  assert.equal(f.saved.at(-1).body.summary.providerId, 'memory-provider');
  assert.deepEqual(f.loop.messages.slice(0, history.length).map(({role,content}) => ({role,content})), history);
  assert.equal(f.loop.getState().usage.total_tokens, segments.length * 15);
});

test('A rejected compression model keeps old memory and full history; retry uses the newly selected model', async () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: ('历史记录' + i).repeat(1500) }));
  {
    let failing = true;
    const f = fixture(async (p, cb) => {
      if (p.tools.length) { emitText(cb, '继续完成'); return; }
      if (failing) {
        cb({ type: 'error', message: 'invalid summarizer key', status: 401 });
      } else { assert.equal(p.model, 'replacement-memory'); emitText(cb, '用户偏好与未完成事项已保留。'); }
    }, history, { contextLimit: 32000, compaction: { model: 'broken-memory' } });
    const originalSummary = { through: 2, text: '先前有效记忆', model: 'previous-model' };
    f.ctx.api.getChat = async () => ({ messages: history, summary: originalSummary });
    await f.loop.load('test'); await f.loop.send('继续');
    assert(f.hooks.errors.length); assert.deepEqual(f.loop.getState().summary, originalSummary);
    assert.equal(f.loop.messages.length, history.length + 1); assert.equal(f.loop.getState().foldedCount, 2);
    assert(f.requests.every(p => !p.tools.length));
    failing = false; f.snapshot.settings.agent.compaction = { model: 'replacement-memory' };
    await f.loop.resume();
    assert.equal(f.requests.at(-1).model, 'test'); assert.equal(f.loop.getState().summary.model, 'replacement-memory');
    assert.equal(f.loop.messages.length, history.length + 2);
  }
});

test('Truncated and empty summaries retry and fall back to saved excerpts without blocking the conversation', async () => {
  const history = [{ role: 'user', content: 'Project constraints. ' + 'Long history. '.repeat(9000) },
    { role: 'assistant', content: 'Saved result.' }];
  let compression = 0;
  const f = fixture(async (payload, cb) => {
    if (payload.tools.length) {
      assert(payload.messages.some(message => String(message.content).includes('Local memory excerpts')));
      assert.equal(payload.messages.at(-1).content, '继续工作');
      emitText(cb, '已继续。');
      return;
    }
    if (++compression === 1) emitText(cb, 'Partial output must not be committed', 'length');
    else {
      assert.equal(payload.stream, false);
      emitText(cb, '');
    }
  }, history, { contextLimit: 32000 });
  await f.loop.load('test');
  assert((await f.loop.send('继续工作')).ok);
  assert.equal(compression, 3);
  assert(!f.loop.getState().summary.text.includes('Partial output must not be committed'));
  assert.equal(f.loop.messages[0].content, history[0].content);
  assert.equal(f.loop.messages.at(-1).content, '已继续。');
});

test('Stopping compaction never commits a partial memory or loses messages', async () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: ('历史' + i).repeat(2000) }));
  const f = fixture(async (p, cb) => {
    assert.equal(p.tools.length, 0); cb({ type: 'delta', content: '未完成的记忆' }); f.loop.stop(); cb({ type: 'done', finish_reason: 'stop' });
  }, history, { contextLimit: 32000 });
  await f.loop.load('test'); await f.loop.send('继续');
  assert.equal(f.loop.getState().summary, null); assert.equal(f.loop.getState().foldedCount, 0);
  assert.equal(f.loop.messages.length, history.length + 1);
  assert.equal(f.saved.at(-1).body.messages.length, history.length + 1);
});

test('An over-limit old single turn resumes through intra-turn compaction and retains full partial output',async()=>{
  const prefix='Saved complete implementation prefix. '.repeat(9000)+'UNIQUE_END';
  const history=[{role:'user',content:'保留中文标题并继续'}, {role:'assistant',content:prefix,incomplete:true}];
  const f=fixture(async(p,cb)=>{
    if(!p.tools.length){emitText(cb,'当前任务：保留中文标题，已输出代码前缀，继续末尾。');return;}
    assert(p.messages.some(m=>m.role==='user'&&m.content==='保留中文标题并继续'));
    assert(p.messages.some(m=>String(m.content).includes('UNIQUE_END')));
    assert(messageTokens(p.messages)<24000);emitText(cb,'完成剩余代码。');
  },history,{contextLimit:32000});
  await f.loop.load('test');assert((await f.loop.resume()).ok);
  assert(f.requests.some(p=>!p.tools.length));assert.equal(f.loop.messages.length,2);
  assert.equal(f.loop.messages[1].content,prefix+'完成剩余代码。');
  assert.equal(f.saved.at(-1).body.messages[1].content,prefix+'完成剩余代码。');
  assert.equal(f.loop.getState().summary.through,1,'newly appended suffix must remain outside durable summary');
});

test('A summary covering every older turn does not prevent compaction of the current long tool chain',async()=>{
  const call={id:'old-read',type:'function',function:{name:'file_read',arguments:JSON.stringify({path:'deck.html',notes:'code '.repeat(20000)})}};
  const history=[{role:'user',content:'旧任务'},{role:'assistant',content:'之前完成'},
    {role:'user',content:'继续当前任务'}, {role:'assistant',content:'已读取工程',tool_calls:[call]},
    {role:'tool',tool_call_id:call.id,name:'file_read',content:'{"ok":true,"path":"deck.html"}'}];
  const f=fixture(async(p,cb)=>emitText(cb,!p.tools.length?'已读取 deck.html；继续当前任务，勿重复修改。':'本轮继续完成。'),history,{contextLimit:32000});
  f.ctx.api.getChat=async()=>({messages:history,summary:{through:2,text:'原先记忆'}});
  await f.loop.load('test');assert((await f.loop.resume()).ok);
  assert.equal(f.loop.getState().summary.through,5);
  assert.equal(f.loop.messages.find(m=>m.role==='tool').tool_call_id,'old-read');
  assert(!f.requests.at(-1).messages.some(m=>m.role==='tool'),'no orphaned tool results');
});

test('A huge latest user request is summarized with paginated original access rather than rejected',async()=>{
  const task='详尽要求：标题、颜色和数据。'.repeat(14000)+'REQUEST_END';
  const f=fixture(async(p,cb)=>emitText(cb,p.tools.length?'开始执行。':'用户提交了完整的长要求，原文可分页读取。'),[],{contextLimit:32000});
  await f.loop.load('test');assert((await f.loop.send(task)).ok);
  const anchor=f.requests.at(-1).messages.find(m=>m.role==='user');assert(anchor.content.includes('resultId:context-'));
  const id=/resultId:(context-[^. ]+)/.exec(anchor.content)[1];assert(f.ctx.agentToolResults.get(id).endsWith('REQUEST_END'));
  assert.equal(f.loop.messages[0].content,task);
});

test('Oversized legacy memory is itself chunked before using a small summarizer',async()=>{
  const history=[{role:'user',content:'之前'},{role:'assistant',content:'完成'},{role:'user',content:'继续'}];
  const oldMemory='Very large existing memory. '.repeat(12000)+'MEMORY_END';let source='';
  const f=fixture(async(p,cb)=>{
    if(!p.tools.length){assert(messageTokens(p.messages)+p.maxTokens<8192*.85);source+=p.messages[1].content.split('【接续记录】\n')[1];emitText(cb,'旧记忆与当前任务已整理。');}
    else emitText(cb,'继续成功。');
  },history,{contextLimit:32000,compaction:{model:'small-memory'}});
  f.snapshot.settings.providers[0].models.push({id:'small-memory',contextLength:8192,maxOutput:512,tools:false});
  f.ctx.api.getChat=async()=>({messages:history,summary:{through:2,text:oldMemory}});
  await f.loop.load('test');assert((await f.loop.resume()).ok);assert(source.includes(oldMemory));assert.equal(f.loop.messages.length,4);
});

test('An upstream context rejection triggers bounded forced compaction even below the local estimate',async()=>{
  let main=0;
  const f=fixture(async(p,cb)=>{
    if(!p.tools.length){emitText(cb,'用户要求继续完成当前工程。');return;}
    if(++main===1){cb({type:'error',status:400,recoverable:false,message:'context_length_exceeded: maximum context length exceeded'});return;}
    assert(p.messages.some(m=>String(m.content).includes('【持久对话记忆】')));emitText(cb,'压缩后继续成功。');
  });
  await f.loop.load('test');assert((await f.loop.send('继续完成当前工程')).ok);
  assert.equal(main,2);assert.equal(f.loop.messages.length,2);assert.equal(f.hooks.errors.length,0);
  const broken=fixture(async(p,cb)=>p.tools.length?cb({type:'error',status:400,recoverable:false,message:'context_length_exceeded'}):emitText(cb,'记忆'));
  await broken.loop.load('test');assert(!(await broken.loop.send('继续')).ok);assert.equal(broken.requests.filter(p=>p.tools.length).length,3);
});

test('Over-limit parallel workers compact using the selected memory model and preserve full artifacts',async()=>{
  const f=fixture(async(p,cb)=>{
    if(!p.tools.length){assert.equal(p.model,'memory');emitText(cb,'工作代码前缀已保存，继续接续。');}
    else emitText(cb,'remaining implementation');
  },[],{compaction:{model:'memory'}});
  f.snapshot.settings.providers[0].models.push({id:'memory',contextLength:8192,maxOutput:512,tools:false});
  const batch=prepareParallelBatch({}, {tasks:parallelTasks},{active:{providerId:'test',model:'test'},toolCallId:'test-call'});
  const prefix='implementation source '.repeat(20000);
  batch.workers[0].messages=[{role:'user',content:'Produce complete implementation'},{role:'assistant',content:prefix,incomplete:true}];
  batch.workers[1].status='complete';batch.workers[1].content='checked';
  const runner=createParallelRunner({ctx:f.ctx,request:(p,cb,signal)=>f.ctx.api.chatStream(p,cb,signal),systemPrompt:()=> 'Worker system.',maxOutput:()=>4096,limits:()=>({budget:24000}),onUsage:()=>{}});
  await runner(batch,{sessionId:'worker-test',signal:new AbortController().signal});
  assert.equal(batch.status,'complete');assert.equal(batch.workers[0].content,prefix+'remaining implementation');assert(batch.workers[0].summary);
  assert(f.requests.filter(p=>!p.tools.length).length>1);
});

test('Context overflow after a successful project mutation compacts progress without replaying the write',async()=>{
  let main=0;
  const f=checkpointFixture(async(p,cb)=>{
    if(!p.tools.length){emitText(cb,'已成功插入文本；避免重复修改，继续完成。');return;}
    if(++main===1){toolReply(cb);return;}
    if(main===2){cb({type:'error',status:400,recoverable:false,message:'maximum context length exceeded'});return;}
    assert(p.messages.some(m=>String(m.content).includes('已成功插入文本')));emitText(cb,'完成交付。');
  });
  await f.loop.load('test');assert((await f.loop.send('修改后交付')).ok);
  assert.equal(f.writes.length,1);assert.equal(f.versions.length,2);assert.equal(f.loop.messages.filter(m=>m.role==='tool').length,1);
});

test('Memory chunks preserve every character and respect request budgets', () => {
  const text = '连续的中文与 emoji 🌱\n'.repeat(6000);
  const chunks = memoryChunks(text, 5000);
  assert(chunks.length > 2); assert.equal(chunks.join(''), text);
  assert(chunks.every((c) => !/[\uD800-\uDBFF]$/.test(c)));
});

test('Long attachments retain their full source and expose paginated access', async () => {
  const source = '附件原文。'.repeat(40000) + 'END_OF_ATTACHMENT';
  const f = fixture(async (payload, cb) => {
    const user = payload.messages.find((m) => m.role === 'user');
    assert(user.content.includes('分页读取')); assert(!user.content.includes('END_OF_ATTACHMENT'));
    emitText(cb, '附件可以分页阅读。');
  });
  await f.loop.load('test'); await f.loop.send('阅读全文', [], { docs: [{ name: 'long.md', text: source }] });
  const doc = f.loop.messages[0].docs[0]; assert.equal(doc.text, source);
  const result = await createToolExecutor(f.ctx).execute('tool_result_read', { resultId: doc.resultId, offset: source.length - 17, limit: 100 }, { permission: 'read' });
  assert(result.content.endsWith('END_OF_ATTACHMENT')); assert.equal(f.saved.at(-1).body.messages[0].docs[0].text, source);
});

test('Explicit resume continues the partial assistant without losing or repeating prior writes', async () => {
  const f = fixture(async (payload, cb, signal, n) => {
    if (n === 1) { cb({ type: 'delta', content: '此前已保留。' }); cb({ type: 'error', status: 401, recoverable: false, message: '服务错误' }); }
    else {
      assert(payload.messages.some((m) => m.role === 'system' && m.content.includes('避免重复修改')));
      emitText(cb, '接着完成。');
    }
  });
  await f.loop.load('test'); await f.loop.send('完成任务'); await f.loop.resume();
  assert.equal(f.loop.messages.filter((m) => m.role === 'assistant').length, 1);
  assert.equal(f.loop.messages.at(-1).content, '此前已保留。接着完成。');
  assert.equal(f.loop.messages.at(-1).incomplete, false); assert.equal(f.loop.messages.at(-1).aborted, false);
});

test('A failed new turn cannot mark an earlier completed answer incomplete', async () => {
  const f = fixture(async (_, cb, signal, n) => {
    if (n === 1) emitText(cb, '上一个任务已经完成。');
    else cb({ type: 'error', status: 401, recoverable: false, message: '密钥错误' });
  });
  await f.loop.load('test'); await f.loop.send('第一个任务'); await f.loop.send('第二个任务');
  assert.equal(f.loop.messages[1].incomplete, false); assert.equal(f.loop.messages.at(-1).role, 'user');
});
test('Reasoning-only and blank history stays saved but cannot become empty assistant API messages', async () => {
  const call = { id: 'previous-call', type: 'function', function: { name: 'app_list_apis', arguments: '{}' } };
  const history = [
    { role: 'user', content: '原来的任务' },
    { role: 'assistant', id: 'reasoning-only', content: '', reasoning: '中断前保留的思考', incomplete: true },
    ...[null, undefined, '   \n', []].map((content) => ({ role: 'assistant', content })),
    { role: 'assistant', content: '', reasoning: '工具前的推理', tool_calls: [call] },
    { role: 'tool', tool_call_id: call.id, name: 'app_list_apis', content: '{"ok":true}' },
    { role: 'assistant', content: '已完成上一步。' },
  ];
  const f = fixture(async (_, cb) => emitText(cb, '继续完成。'), history);
  await f.loop.load('test'); await f.loop.send('继续');
  const sent = f.requests[0].messages.filter((m) => m.role === 'assistant');
  assert.equal(sent.length, 2);
  assert(sent.some((m) => m.tool_calls?.[0].id === call.id && m.reasoning_content === '工具前的推理'));
  assert(f.requests[0].messages.some((m) => m.role === 'tool' && m.tool_call_id === call.id));
  assert.equal(f.loop.messages.find((m) => m.id === 'reasoning-only').reasoning, '中断前保留的思考');
  assert.equal(f.saved.at(-1).body.messages.find((m) => m.id === 'reasoning-only').content, '');
});

test('A reasoning-only interrupted response can reconnect without sending an empty assistant', async () => {
  const f = fixture(async (_, cb, signal, n) => {
    if (n === 1) cb({ type: 'reasoning', content: '仅生成思考时连接中断' });
    else emitText(cb, '恢复后完整回答。');
  });
  await f.loop.load('test'); const result = await f.loop.send('继续我的任务');
  assert.equal(result.ok, true);
  assert(!f.requests[1].messages.some((m) => m.role === 'assistant' && !m.content && !m.tool_calls?.length));
  assert.equal(f.loop.messages.at(-1).content, '恢复后完整回答。');
  assert.equal(f.loop.messages.at(-1).reasoning, '仅生成思考时连接中断');
});

test('Proxy repairs blank assistant history for old clients while preserving valid tool turns', async () => {
  let received;
  const call = { id: 'proxy-call', type: 'function', function: { name: 'app_list_apis', arguments: '{}' } };
  const messages = [
    { role: 'user', content: '开始' },
    ...[null, undefined, '', '  ', []].map((content) => ({ role: 'assistant', content, reasoning_content: '保留在原始记录中的推理' })),
    { role: 'assistant', content: '', tool_calls: [call], reasoning_content: '有效工具调用的推理' },
    { role: 'tool', tool_call_id: call.id, content: '{"ok":true}' },
    { role: 'assistant', content: '有效正文。' },
    { role: 'user', content: '继续' },
  ];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part; received = JSON.parse(raw);
    const invalid = received.messages.some((m) => m.role === 'assistant' && !(typeof m.content === 'string' && m.content.trim()) && !m.tool_calls?.length);
    res.writeHead(invalid ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(invalid ? { error: { message: 'Invalid assistant message: content or tool_calls must be set' } } : { choices: [{ message: { content: '恢复成功。' }, finish_reason: 'stop' }] }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = http.createServer((req, res) => proxyChat({ req, res, base: 'http://127.0.0.1:' + upstream.address().port,
    wire: 'openai', headers: {}, model: 'test', messages, tools: [], maxTokens: 1024, stream: true }));
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  try {
    const response = await fetch('http://127.0.0.1:' + proxy.address().port), events = [];
    for await (const event of readSSE(response.body)) events.push(JSON.parse(event.data));
    assert(!events.some((e) => e.type === 'error'), JSON.stringify(events));
    assert.equal(events.at(-1).finish_reason, 'stop');
    assert.equal(received.messages.length, 5);
    assert.equal(received.messages[1].tool_calls[0].id, call.id);
    assert.equal(received.messages[1].reasoning_content, '有效工具调用的推理');
    assert.equal(messages.length, 10);
  } finally {
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise((r) => proxy.close(r)), new Promise((r) => upstream.close(r))]);
  }
});

test('Proxy reports missing upstream finish marker instead of inventing success', async () => {
  let anthropic = false, json = false;
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume */ }
    if (json) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: 'JSON 完整回答' }], stop_reason: 'end_turn' })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(anthropic ? 'event: content_block_delta\ndata: {"delta":{"text":"中文尾帧"}}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}' : 'data: {"choices":[{"delta":{"content":"部分内容"}}]}\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const proxy = http.createServer((req, res) => proxyChat({ req, res, base, wire: anthropic ? 'anthropic' : 'openai', headers: {}, model: 'test', messages: [], tools: [], maxTokens: 4096, stream: !json }));
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const url = 'http://127.0.0.1:' + proxy.address().port;
  try {
    let res = await fetch(url), events = []; for await (const e of readSSE(res.body)) events.push(JSON.parse(e.data));
    assert.equal(events.at(-1).finish_reason, null); assert.equal(events.at(-1).incomplete, true);
    anthropic = true;
    res = await fetch(url); events = []; for await (const e of readSSE(res.body)) events.push(JSON.parse(e.data));
    assert.equal(events[0].content, '中文尾帧'); assert.equal(events.at(-1).finish_reason, 'stop');
    json = true;
    res = await fetch(url); events = []; for await (const e of readSSE(res.body)) events.push(JSON.parse(e.data));
    assert.equal(events[0].content, 'JSON 完整回答'); assert.equal(events.at(-1).finish_reason, 'stop');
  } finally { proxy.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise((r) => proxy.close(r)), new Promise((r) => upstream.close(r))]); }
});
