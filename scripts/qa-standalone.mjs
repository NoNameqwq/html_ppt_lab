import { qaWebDAV } from './qa-webdav.mjs';
/* Real-browser acceptance for the Agent. Isolated data, local mock, no real API keys. */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { qaSkillPicker } from './qa-skill-picker.mjs';
import { fileURLToPath } from 'node:url';
import {pptxFixture} from './pptx-fixture.mjs';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { qaCompaction } from './qa-compaction.mjs';
import { qaFavorites, favoriteReply } from './qa-favorites.mjs';
import { qaPersonalization, qaEfficiency } from './qa-personalization.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'output', 'playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const report = { steps: [], errors: [] };
let cdp;
async function port() {
  const socket = net.createServer(); await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const value = socket.address().port; await new Promise((r) => socket.close(r)); return value;
}
async function until(fn, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { const v = await fn(); if (v) return v; } catch {} await sleep(100); }
  throw new Error('等待超时：' + label);
}
function launch(file, env) {
  const child = spawn(process.execPath, [file], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  child.stderr.on('data', (b) => { if (String(b).includes('Error')) console.error(String(b)); });
  children.push(child); return child;
}
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((r, j) => { this.ws.addEventListener('open', r); this.ws.addEventListener('error', j); });
    this.ws.addEventListener('message', ({ data }) => {
      const m = JSON.parse(data);
      if (m.id) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      if (m.method === 'Runtime.exceptionThrown') report.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') report.errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
    });
  }
  send(method, params = {}) {
    const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timeout')); }, 30000); this.pending.set(id, { resolve, reject, timer }); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}
const ev = (source) => cdp.eval(source);
const L = 'window.__WDS__.agent.loop';
const ready = () => until(() => ev(`!!window.__WDS__?.agent?.loop && !${L}.getState().loading && !!window.__WDS__.getEditor()?.bridge?.ready`), '编辑器与会话就绪');
const idle = () => until(() => ev(`!${L}.streaming`), '本轮完成');
async function input(text, send = true) {
  await ev(`(() => { const el = document.querySelector('.agw-input'); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', {bubbles:true})); el.focus(); })()`);
  if (send) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(80);
  }
}
async function step(name, fn) {
  const start = Date.now();
  try { const detail = await fn(); report.steps.push({ name, ok: true, ms: Date.now() - start, detail }); console.log('✓ ' + name); }
  catch (e) { report.steps.push({ name, ok: false, error: e.message }); throw e; }
}
async function shot(name) {
  await sleep(150); const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(out, name + '.png'), Buffer.from(r.data, 'base64'));
}
async function newChat() { await ev(`${L}.newChat()`); await idle(); }
async function json(base, route, body) {
  const r = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert(r.ok, route + ': ' + r.status); return r.json();
}
function pdfFixture(){
  const content='BT /F1 20 Tf 60 700 Td (Standalone PDF attachment verified) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const xref=pdf.length;pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
  return pdf+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
}
let mock;
const teamRequests=[];
const staticEffect={id:'static-custom',kind:'overlay',name:'静态 SVG 特效',selector:'[data-wpx-tl="static-custom"]',html:'<div style="position:absolute;left:800px;top:400px;width:200px;height:200px;opacity:0"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#9cafff"/></svg></div>',keyframes:[{t:0,props:{opacity:0}},{t:700,props:{opacity:1,scale:2}},{t:1400,props:{opacity:0}}]};
try {
  await fs.mkdir(out,{recursive:true});
  const debugPort=await port(),mockPort=await port(),data=path.join(root,'output','static-qa','browser-'+Date.now());
  // A CORS-enabled mock upstream. No localhost app server is started.
  mock=http.createServer(async(req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','authorization,content-type,x-api-key,anthropic-version,anthropic-dangerous-direct-browser-access');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
    if(req.url.startsWith('/no-cors/'))res.removeHeader('Access-Control-Allow-Origin');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'gpt-test',context_length:1000000},{id:'gpt-image-1.5'}]}));return;}
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw||'{}');
    if(req.url==='/v1/tools/search'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({results:[{title:'Static search result',url:'https://example.com',content:body.query}]}));return;}
    if(req.url==='/v1/images/generations'){if(body.prompt==='SLOW_IMAGE')await sleep(350);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bZsAAAAASUVORK5CYII='}]}));return;}
    if(req.url==='/v1/chat/completions'){
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const send=(delta,finish=null)=>res.write('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
      const user=body.messages.findLast(m=>m.role==='user'&&!(Array.isArray(m.content)&&m.content[0]?.text?.startsWith('Visual evidence from deck_capture_slide')))?.content||'';
      const favorite=favoriteReply(body.messages);if(favorite){send(favorite,favorite.tool_calls?'tool_calls':'stop');res.end('data: [DONE]\n\n');return;}
      if(body.messages[0]?.content?.startsWith('Maintain a complete working memory')){send({content:'保留中文标题、深色背景，关键文件 assets/diagram.svg；继续完成布局。'},'stop');res.end('data: [DONE]\n\n');return;}
      if(String(user).includes('COMPACTION_QA')){send({content:'已根据工作记忆继续。'},'stop');res.end('data: [DONE]\n\n');return;}
      if(String(user).includes('STATIC_VISION')) {
        const previous=body.messages.find(m=>m.role==='tool'&&m.tool_call_id==='static-view');
        if(!previous)send({tool_calls:[{index:0,id:'static-view',type:'function',function:{name:'deck_capture_slide',arguments:JSON.stringify({index:0,region:{x:100,y:100,w:600,h:400},scale:1})}}]},'tool_calls');
        else {
          const image=body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(b=>b.type==='image_url');
          send({content:image?.image_url.url.startsWith('data:image/png;base64,')?'静态页面图片已收到并完成查看。':'未收到图片。'},'stop');
        }
        res.end('data: [DONE]\n\n');return;
      }
      if(String(user).includes('STATIC_TEAM')) {
        const phase=/Current phase: (\w+)/.exec(body.messages.findLast(m=>m.role==='system'&&m.content.includes('Three-role collaboration'))?.content||'')?.[1];
        teamRequests.push({model:body.model,phase,tools:body.tools.map(t=>t.function.name)});
        const called=id=>body.messages.some(m=>m.role==='tool'&&m.tool_call_id===id);
        const tool=(id,name,args)=>send({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');
        send({content:'静态协作阶段：'+phase+'。'});
        if(phase==='design')tool('static-team-design','agent_handoff',{target:'implement',task:'插入 STATIC_TEAM_IMPLEMENTED 说明，然后交给检查代理。'});
        else if(phase==='implement'&&!called('static-team-write'))tool('static-team-write','deck_insert_text',{text:'STATIC_TEAM_IMPLEMENTED',x:160,y:600,w:1000,h:80});
        else if(phase==='implement')tool('static-team-review','agent_handoff',{target:'review',task:'读取实际页面，检查新增文本。'});
        else if(phase==='review'&&!called('static-team-read'))tool('static-team-read','deck_read_slide',{index:0});
        else if(phase==='review')tool('static-team-pass','agent_handoff',{target:'complete',task:'已读取实际页面并核对新增文本。'});
        else send({content:'静态三角色协作交付完成。'},'stop');
        res.end('data: [DONE]\n\n');return;
      }
      if(String(user).includes('STATIC_TIMELINE')) {
        const read=body.messages.find(m=>m.role==='tool'&&m.tool_call_id==='read-static-timeline');
        const written=body.messages.some(m=>m.role==='tool'&&m.tool_call_id==='write-static-timeline');
        const previous=read?JSON.parse(read.content).timeline:null;
        if(written)send({content:'静态时间线已完成。'},'stop');
        else send({tool_calls:[{index:0,id:read?'write-static-timeline':'read-static-timeline',type:'function',function:{name:read?'deck_set_timeline':'deck_get_timeline',arguments:JSON.stringify(read?{timeline:{...(previous||{version:2,duration:6400,pages:[],tracks:[]}),tracks:[...(previous?.tracks||[]),staticEffect]}}:{})}}]},'tool_calls');
        res.end('data: [DONE]\n\n');return;
      }
      if(String(user).includes('STATIC_TOOL')&&!body.messages.some(m=>m.role==='tool'))send({tool_calls:[{index:0,id:'insert-static',type:'function',function:{name:'deck_insert_text',arguments:JSON.stringify({text:'单文件 Agent 的实际修改',x:140,y:780,w:1400,h:90})}}]},'tool_calls');
      else send({content:'静态模式完整回复：'+(body.messages.some(m=>m.role==='tool')?'已写入页面。':'你好，继续创作。')},'stop');
      res.end('data: [DONE]\n\n');return;
    }
    res.writeHead(404);res.end('{}');
  });await new Promise(r=>mock.listen(mockPort,'127.0.0.1',r));
  const chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port='+debugPort,'--user-data-dir='+path.join(data,'chrome'),'--window-size=1600,1000','about:blank'],{stdio:'ignore',windowsHide:true});children.push(chrome);
  const target=await until(async()=>(await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json()).find(p=>p.type==='page'),'Chrome');
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();await cdp.send('Page.enable');await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate',{url:pathToFileURL(path.join(root,'WebDeck.html')).href+'?qa=1#/'});
  await until(()=>ev(`!!window.__WDS__?.agent?.loop&&!!window.__WDS_STATIC__&&!${L}.getState().loading`),'单文件工作台就绪',30000);
  const api=(route,body,method='POST')=>ev(`(async()=>{const r=await fetch(${JSON.stringify(route)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}});const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));return data})()`);
  let project,version;
  await step('双击 HTML 从 file:// 启动，无任何应用后端，五套模板可用',async()=>{
    assert.equal(await ev(`location.protocol`),'file:');assert.equal(await ev(`document.documentElement.dataset.runtime`),'standalone');
    assert.equal((await ev(`window.__WDS__.api.templates()`)).templates.length,5);assert.deepEqual(report.errors,[]);await shot('static-library');
  });
  await step('新建工程、编辑桥、公式和 SVG 可用，素材无需本地 HTTP 地址',async()=>{
    ({project}=await api('/api/projects',{name:'单文件验收',templateId:'knowledge-garden'}));
    await ev(`window.__WDS__.navigate('#/p/'+${JSON.stringify(project.id)})`);await ready();
    assert.equal(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelectorAll('.wpx-slide').length`),8);
    assert.equal(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelectorAll('.katex').length`),2);
    assert(await ev(`window.__WDS__.getEditor().bridge.call('getState').then(s=>s.slides.length===8)`));
    await until(()=>ev(`!!document.querySelector('.slide-list iframe')?.contentDocument?.querySelector('#wpx-stage')`),'缩略图就绪');
    assert(await ev(`[...document.querySelectorAll('.slide-list iframe')].every(f=>!f.contentDocument?.querySelector('#wds-present-tools'))`));await shot('static-editor');
  });
  await step('静态版聊天底部 Skill 快捷多选、搜索、持久化及窄屏主题', () => qaSkillPicker({ ev, cdp, until, shot, mode: 'static' }));
  await step('浏览器直连模型，流式多轮、实际工具调用和版本交付可用',async()=>{
    await api('/api/settings/user',{providers:[{id:'static-test',name:'Static Test',baseUrl:'http://127.0.0.1:'+mockPort+'/v1',apiKey:'fake-static-secret',model:'gpt-test',models:[{id:'gpt-test',contextLength:1000000,maxOutput:8192,tools:true,vision:true}],wire:'openai'}]},'PUT');
    await ev(`(async()=>{const settings=await window.__WDS__.api.getSettings();window.__WDS__.store.update(s=>{s.settings=settings});window.__WDS__.bus.runCommand('app.toggleAgent');window.__WDS__.agent.loop.setProvider('static-test','gpt-test')})()`);
    await input('STATIC_TOOL');await idle();
    const messages=await ev(`${L}.messages`);assert(messages.some(m=>m.role==='tool'&&JSON.parse(m.content).ok),JSON.stringify(messages));
    assert(await ev(`window.__WDS__.getEditor().iframe.contentDocument.body.textContent.includes('单文件 Agent 的实际修改')`));
    const versions=await ev(`window.__WDS__.api.listVersions(${JSON.stringify(project.id)})`);assert.equal(versions.versions.length,2);
    version=versions.versions.find(v=>v.kind==='before').id;
    assert(await ev(`!!document.querySelector('.agw-delivery-play')`));
    await input('继续解释');await idle();assert((await ev(`${L}.messages`)).filter(m=>m.role==='user').length===2);await shot('static-agent');
  });
  await step('版本恢复同步回溯对话，删除当前分支后续消息',async()=>{
    await ev(`${L}.restoreCheckpoint(${JSON.stringify(version)},{rewindConversation:true})`);await ready();
    assert(!await ev(`window.__WDS__.getEditor().iframe.contentDocument.body.textContent.includes('单文件 Agent 的实际修改')`));
    assert.equal((await ev(`${L}.messages`)).length,0);
  });
  await step('刷新后工程、密钥和版本保留，设置输出不泄露明文密钥',async()=>{
    const previous=await ev('performance.timeOrigin');await cdp.send('Page.reload');await until(()=>ev(`performance.timeOrigin!==${previous}`),'刷新完成');await ready();
    const result=await ev(`window.__WDS__.api.getSettings()`);assert(result.providers.find(p=>p.id==='static-test').keySet);assert(!JSON.stringify(result).includes('fake-static-secret'));
    assert((await ev(`window.__WDS__.api.listVersions(${JSON.stringify(project.id)})`)).versions.length>=3);
  });
  await step('静态模式极高思考路由三个模型、只读检查，过程交错折叠并持久化',async()=>{
    await api('/api/settings/user',{providers:[{id:'static-empty',name:'No default model',baseUrl:'http://127.0.0.1:'+mockPort+'/v1',apiKey:'fake-unused-secret',model:'',models:[],wire:'openai'}],agent:{collaboration:{design:{providerId:'static-test',model:'static-designer'},implement:{providerId:'static-test',model:'static-worker'},review:{providerId:'static-test',model:'static-reviewer'}}}},'PUT');
    await ev(`(async()=>{const settings=await window.__WDS__.api.getSettings();window.__WDS__.store.update(s=>{s.settings=settings});${L}.setProvider('static-empty',null);window.__WDS__.bus.runCommand('app.toggleAgent')})()`);
    await ev(`document.querySelector('.agw-effort').click()`);await ev(`[...document.querySelectorAll('.agw-menu-item')].find(b=>b.textContent.includes('极高')).click()`);
    assert.equal(await ev(`${L}.getState().model`),null);
    assert.equal(await ev(`getComputedStyle(document.querySelector('.agw-model')).display`),'none');
    await input('STATIC_TEAM');await idle();
    assert(teamRequests.some(r=>r.model==='static-designer'&&r.phase==='design'));
    assert(teamRequests.some(r=>r.model==='static-worker'&&r.phase==='implement'));
    assert(teamRequests.some(r=>r.model==='static-reviewer'&&r.phase==='review'));
    assert(teamRequests.filter(r=>r.phase==='review').every(r=>!r.tools.includes('deck_insert_text')));
    assert.equal(teamRequests.at(-1).phase,'final');
    assert(await ev(`window.__WDS__.getEditor().iframe.contentDocument.body.textContent.includes('STATIC_TEAM_IMPLEMENTED')`));
    const turn=await ev(`(()=>{const t=[...document.querySelectorAll('.agw-turn')].at(-1),l=t.querySelector('.agw-ledger');return {collapsed:!l.open,final:t.querySelector(':scope > .agw-final').textContent,parts:l.querySelectorAll('.agw-prose').length}})()`);
    assert(turn.collapsed);assert(turn.final.includes('静态三角色协作交付完成'));assert(turn.parts>=3);
    const previous=await ev('performance.timeOrigin');await cdp.send('Page.reload');await until(()=>ev(`performance.timeOrigin!==${previous}`),'协作刷新');await ready();
    await until(()=>ev(`${L}.messages.some(m=>m.collaboration?.phase==='done')`),'静态协作会话恢复');
    assert.equal((await ev(`window.__WDS__.api.getSettings()`)).agent.collaboration.review.model,'static-reviewer');
    await ev(`window.__WDS__.bus.runCommand('app.toggleAgent')`);
    assert.equal(await ev(`getComputedStyle(document.querySelector('.agw-model')).display`),'none');await shot('static-collaboration');
    await ev(`document.querySelector('.agw-effort').click()`);await ev(`[...document.querySelectorAll('.agw-menu-item')].find(b=>b.textContent.trim()==='中').click()`);await shot('static-collaboration');
    assert(await ev(`document.querySelector('.agw-model').getBoundingClientRect().width>0`));
    await ev(`${L}.setProvider('static-test','gpt-test');window.__WDS__.bus.runCommand('app.toggleAgent')`);
  });
  await step('file:// 多模态截图工具输出实际画面并传入模型上下文',async()=>{
    await ev(`window.__WDS__.bus.runCommand('app.toggleAgent')`);await input('STATIC_VISION');await idle();
    const capture=await ev(`${L}.messages.findLast(m=>m.name==='deck_capture_slide')`);assert(capture?.images?.[0].startsWith('data:image/png;base64,'));
    assert.equal(JSON.parse(capture.content).visual.imageWidth,600);
    assert(await ev(`[...document.querySelectorAll('.agw-final')].at(-1).textContent.includes('图片已收到')`));
    await ev(`window.__WDS__.bus.runCommand('app.toggleAgent')`);
  });
  await step('可编辑 PPTX 在浏览器解析为网页，离线放映包含本地素材',async()=>{
    const bytes=await pptxFixture(),result=await api('/api/projects/import',{fileName:'fixture.pptx',name:'静态 PPTX',dataUrl:'data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,'+bytes.toString('base64')});
    assert.equal(result.report.slides,2);const html=await ev(`fetch('/api/projects/'+${JSON.stringify(result.project.id)}+'/export').then(r=>r.text())`);assert(html.includes('data:image/png;base64'));
    await ev(`window.__WDS__.navigate('#/p/'+${JSON.stringify(result.project.id)})`);await ready();assert.equal(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelectorAll('.wpx-slide').length`),2);
  });
  await step('新增公式、SVG 与上传图片立即在画布显示，样式和素材完全内联',async()=>{
    const math=await ev(`window.__WDS__.bus.runCommand('insert.math',{latex:'E=mc^2'})`);assert(math.ok);
    const svg=await ev(`window.__WDS__.bus.runCommand('insert.svg',{svg:'<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="green"/></svg>'})`);assert(svg.ok);
    assert(await ev(`(()=>{const d=window.__WDS__.getEditor().iframe.contentDocument;return !!d.querySelector('[data-wds-latex] .katex')&&!!d.querySelector('[data-wds-svg] circle')&&[...d.querySelectorAll('style')].some(s=>s.textContent.includes('KaTeX_Main')&&s.textContent.includes('data:font/woff2'))&&!d.querySelector('link[href^="/app/vendor/"]')})()`));
    const asset=await ev(`window.__WDS__.api.uploadAssetDataUrl(window.__WDS__.getEditor().projectId,'uploaded.png','data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bZsAAAAASUVORK5CYII=')`);
    const image=await ev(`window.__WDS__.bus.runCommand('insert.image',{src:${JSON.stringify(asset.url)}})`);assert(image.ok);
    await until(()=>ev(`(()=>{const d=window.__WDS__.getEditor().iframe.contentDocument;return [...d.querySelectorAll('img')].filter(i=>i.src.startsWith('data:')&&i.naturalWidth>0).length>=2})()`),'插入图片实际显示');
  });
  await step('生图默认关闭，手动开启后只保存到对话素材目录',async()=>{
    const denied=await ev(`fetch('/api/projects/'+${JSON.stringify(project.id)}+'/generate-image',{method:'POST',body:JSON.stringify({prompt:'leaf'})}).then(r=>r.status)`);assert.equal(denied,403);
    const agentDenied=await ev(`fetch('/api/settings',{method:'PUT',body:JSON.stringify({imageGeneration:{enabled:true}})}).then(r=>r.status)`);assert.equal(agentDenied,403);
    await api('/api/settings/user',{imageGeneration:{enabled:true,baseUrl:'http://127.0.0.1:'+mockPort+'/v1',apiKey:'fake-image-secret',model:'auto',models:[{id:'gpt-image-1.5'}]}},'PUT');
    const original=await ev(`window.__WDS_STATIC__.state.projects[${JSON.stringify(project.id)}].files['index.html']`);
    const result=await api('/api/projects/'+project.id+'/generate-image',{prompt:'leaf',size:'1536x1024',quality:'high',sessionId:'static-image-chat'});assert(result.url.startsWith('assets/chats/static-image-chat/'));assert.equal(result.inserted,false);
    assert.equal(await ev(`window.__WDS_STATIC__.state.projects[${JSON.stringify(project.id)}].files['index.html']`),original);
    assert((await ev(`fetch('/api/projects/'+${JSON.stringify(project.id)}+'/file?path='+${JSON.stringify(result.url)}).then(r=>r.json())`)).content.startsWith('data:image/png;base64'));
  });
  await step('生成中关闭生图立即生效，未把关闭后的结果写入素材',async()=>{
    const result=await ev(`(async()=>{const state=window.__WDS_STATIC__.state.projects[${JSON.stringify(project.id)}],before=Object.keys(state.files).length;const pending=fetch('/api/projects/'+${JSON.stringify(project.id)}+'/generate-image',{method:'POST',body:JSON.stringify({prompt:'SLOW_IMAGE'})});await new Promise(r=>setTimeout(r,60));await window.__WDS__.api.putUserSettings({imageGeneration:{enabled:false}});const r=await pending;return {status:r.status,unchanged:Object.keys(state.files).length===before}})()`);
    assert.equal(result.status,403);assert(result.unchanged);
  });
  await step('自定义模板保存、ZIP 导出与重新导入',async()=>{
    const t=await api('/api/templates',{projectId:project.id,name:'静态自定义模板'});
    const zip=await ev(`fetch('/api/templates/'+${JSON.stringify(t.template.id)}+'/export').then(r=>r.blob()).then(b=>new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result);f.readAsDataURL(b)}))`);
    const copy=await api('/api/templates',{fileName:'template.zip',dataUrl:zip,name:'重新导入'});assert(copy.template.custom);
  });
  await step('自动发现模型、浏览器直连搜索，模型列表不暴露密钥',async()=>{
    const models=await api('/api/ai/models',{providerId:'static-test'});assert(models.models.some(m=>m.id==='gpt-test'));
    const noKey=await ev(`fetch('/api/ai/models',{method:'POST',body:JSON.stringify({providerId:'static-test',clearKey:true})}).then(r=>r.json())`);assert(noKey.error);
    const images=await api('/api/image-models',{});assert.equal(images.recommended,'gpt-image-1.5');
    await api('/api/settings/user',{search:{provider:'deepseek',baseUrl:'http://127.0.0.1:'+mockPort,apiKey:'fake-search-secret'}},'PUT');
    assert.equal((await api('/api/search',{query:'knowledge garden'})).results[0].content,'knowledge garden');
    assert(!JSON.stringify(models).includes('fake-static-secret'));
  });
  await step('不支持浏览器跨域的 API 返回明确 CORS 说明',async()=>{
    const result=await ev(`fetch('/api/ai/models',{method:'POST',body:JSON.stringify({providerId:'static-test',baseUrl:${JSON.stringify('http://127.0.0.1:'+mockPort+'/no-cors')}})}).then(r=>r.json())`);
    assert(result.error.message.includes('CORS'));assert(result.error.message.includes('BAT'));
  });
  await step('PDF 附件使用内置解析器和 Worker，从 file:// 读取正文',async()=>{
    await ev(`window.__WDS__.bus.runCommand('app.toggleAgent')`);
    await ev(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(pdfFixture())}],'static-fixture.pdf',{type:'application/pdf'}));const input=document.querySelector('.agw-composer input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change'))})()`);
    await until(()=>ev(`document.querySelector('.agw-file')?.dataset.status==='ready'`),'PDF 读取',15000);
    await input('阅读 PDF');await idle();
    assert((await ev(`${L}.messages.findLast(m=>m.role==='user').docs[0].text`)).includes('Standalone PDF attachment verified'));
  });
  await step('导出演示在独立放映窗口运行，素材与指定起始页有效',async()=>{
    await input('STATIC_TIMELINE');await idle();
    assert(await ev(`!!window.__WDS__.getEditor().iframe.contentDocument.querySelector('[data-wpx-tl="static-custom"] svg')`));
    await ev(`window.__WDS__.getEditor().saveNow({reason:'qa'})`);
    await ev(`window.open('/p/'+${JSON.stringify(project.id)}+'/index.html#4','static-presentation');true`);
    const page=await until(async()=>(await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json()).find(p=>p.type==='page'&&p.id!==target.id),'独立放映窗口');
    const presentation=new CDP(page.webSocketDebuggerUrl);await presentation.open();
    try{await presentation.send('Runtime.enable');await until(()=>presentation.eval(`window.__WPX__?.getState().current===3`),'离线放映定位');
      const html=await presentation.eval(`document.documentElement.outerHTML`);assert(!html.includes('fake-static-secret'));assert(!await presentation.eval(`!!document.querySelector('#wpx-bridge')`));assert(html.includes('data:font/woff2'));
      await until(()=>presentation.eval(`!!window.__WDS_PRESENTATION__?.getState`),'静态放映工具栏');
      assert.equal(await presentation.eval(`document.documentElement.dataset.wdsCursor`),'hide');
      await presentation.eval(`document.querySelector('[data-tool=pen]').click()`);assert.equal(await presentation.eval(`window.__WDS_PRESENTATION__.getState().mode`),'pen');
    }finally{await presentation.send('Page.close');presentation.ws.close();}
  });
  let backup;
  await step('工作区备份与私有 HTML 导出包含配置、工程、对话和版本',async()=>{
    await ev(`(()=>{window.__qaDownloads=[];const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.download&&this.href.startsWith('blob:'))window.__qaDownloads.push({name:this.download,url:this.href});else click.call(this)};window.__WDS__.bus.runCommand('app.staticWorkspace')})()`);
    const clickLabel=label=>ev(`[...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
    await clickLabel('备份 JSON');await until(()=>ev(`window.__qaDownloads.length===1`),'JSON 备份下载');
    backup=await ev(`fetch(window.__qaDownloads[0].url).then(r=>r.json())`);assert(backup.settings.providers.find(p=>p.id==='static-test').apiKey==='fake-static-secret');assert(backup.projects[project.id].versions.length>=3);
    await clickLabel('导出私有 HTML');await until(()=>ev(`window.__qaDownloads.length===2`),'私有 HTML 下载');
    const html=await ev(`fetch(window.__qaDownloads[1].url).then(r=>r.text())`);assert(html.includes('wds-portable-state'));assert(html.includes('fake-static-secret'));
    const portablePath=path.join(data,'private workbench.html');await fs.writeFile(portablePath,html);
    const previous=await ev('performance.timeOrigin');await cdp.send('Page.navigate',{url:pathToFileURL(portablePath).href+'#/p/'+project.id});await until(()=>ev(`performance.timeOrigin!==${previous}`),'私有工作台打开');await ready();
    assert.equal(await ev(`window.__WDS_STATIC__.state.settings.providers.find(p=>p.id==='static-test').apiKey`),'fake-static-secret');
    assert.equal(await ev(`window.__WDS_STATIC__.state.projects[${JSON.stringify(project.id)}].versions.length`),backup.projects[project.id].versions.length);
    assert.deepEqual(await ev(`window.__WDS_STATIC__.state.projects[${JSON.stringify(project.id)}].chats`),backup.projects[project.id].chats);
    assert.deepEqual(await ev(`window.__WDS_STATIC__.state.projects[${JSON.stringify(project.id)}].branchState`),backup.projects[project.id].branchState);
  });
  await step('JSON 备份可以经界面导入，刷新后继续使用',async()=>{
    backup.projects[project.id].meta.name='备份恢复验收';
    await ev(`(()=>{const click=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.accept==='.json')window.__qaImport=this;else click.call(this)};window.__WDS__.bus.runCommand('app.staticWorkspace')})()`);
    await ev(`[...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent==='导入备份').click()`);
    await ev(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(JSON.stringify(backup))}],'workspace.json',{type:'application/json'}));window.__qaImport.files=transfer.files;window.__qaImport.dispatchEvent(new Event('change'))})()`);
    await until(()=>ev(`document.querySelectorAll('.modal-wrap').length===2`),'导入确认');
    const previous=await ev('performance.timeOrigin');await ev(`[...document.querySelectorAll('.modal-wrap')].at(-1).querySelector('.modal-foot .btn--primary').click()`);
    await until(()=>ev(`performance.timeOrigin!==${previous}&&window.__WDS_STATIC__?.state.projects[${JSON.stringify(project.id)}]?.meta.name==='备份恢复验收'&&document.readyState==='complete'`),'导入并刷新');await ready();
    assert.equal((await ev(`window.__WDS__.api.getProject(${JSON.stringify(project.id)})`)).project.name,'备份恢复验收');
  });
  await step('单文件模式支持独立上下文压缩模型、刷新持久化和真实网络调用',()=>qaCompaction({ev,cdp,until,shot,baseUrl:'http://127.0.0.1:'+mockPort+'/v1',providerId:'static-test',model:'gpt-test',mode:'static'}));
  await step('WebDAV 挂载、ZIP 备份、云端列表与完整恢复可在浏览器使用',()=>qaWebDAV({ev,cdp,until,shot,mode:'static'}));
  await step('元素收藏支持跨工程素材、预览、撤销重做及聊天工具交付',()=>qaFavorites({ev,cdp,until,shot,mode:'static'}));
  await step('界面字体、快速生成、关闭思考和实时计时可操作并持久化',()=>qaEfficiency({ev,cdp,until,shot,mode:'static',providerId:'static-test',model:'gpt-test'}));
  await step('华丽动效、项目归档、供应商名称和聊天模型名单可操作并持久化',()=>qaPersonalization({ev,cdp,until,shot,mode:'static',baseUrl:'http://127.0.0.1:'+mockPort+'/v1',providerId:'static-test',model:'gpt-test'}));
  await step('浏览器无 JavaScript 异常',async()=>assert.deepEqual(report.errors,[]));
}catch(error){report.fatal=error.stack;console.error(error.stack);process.exitCode=1;try{await shot('static-failure');}catch{}}
finally{
  await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'standalone-report.json'),JSON.stringify(report,null,2));cdp?.ws.close();for(const child of children.reverse())child.kill();mock?.closeAllConnections();mock?.close();console.log(report.steps.filter(s=>s.ok).length+'/'+report.steps.length+' checks passed');
}
