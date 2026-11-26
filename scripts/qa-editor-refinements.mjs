/* Real-browser acceptance for the Agent. Isolated data, local mock, no real API keys. */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {pptxFixture} from './pptx-fixture.mjs';

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
try {
  await fs.mkdir(out, { recursive: true });
  const appPort = await port(), modelPort = await port(), debugPort = await port();
  const base = 'http://127.0.0.1:' + appPort;
  const data = path.join(root, 'output', 'agent-qa', 'browser-' + Date.now());
  launch('server.mjs', { PORT: String(appPort), WDS_DATA_DIR: path.join(data, 'data'), WDS_PROJECTS_DIR: path.join(data, 'projects'), WDS_LOG: '0' });
  launch('scripts/mock-agent-workspace.mjs', { AGENT_MOCK_PORT: String(modelPort) });
  await until(async () => (await fetch(base + '/api/health')).ok, '独立服务');
  await until(async () => (await fetch('http://127.0.0.1:' + modelPort)).ok, '本地模型');
  const settings = { providers: [{ id: 'workspace-test', name: 'Workspace Test', baseUrl: 'http://127.0.0.1:' + modelPort + '/v1', wire: 'openai', apiKey: 'test-only', model: 'workspace-test', models: [{ id: 'workspace-test', contextLength: 131072, maxOutput: 8192, tools: true, vision: true },{id:'team-reviewer',contextLength:131072,maxOutput:8192,tools:true,vision:true}] }], agent: { maxTokens: 8192 } };
  assert((await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })).ok);
  const { project } = await json(base, '/api/projects', { name: '新创作能力验收', templateId: 'knowledge-garden' });
  const chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(data, 'chrome'), '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  children.push(chrome);
  const target = await until(async () => (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).find((p) => p.type === 'page'), 'Chrome');
  cdp = new CDP(target.webSocketDebuggerUrl); await cdp.open();
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('wds:agent:model',JSON.stringify({providerId:'workspace-test',model:'workspace-test'})); localStorage.setItem('wds:agent:permission','full');` });
  await cdp.send('Page.navigate', { url: base + '/?qa=1#/p/' + encodeURIComponent(project.id) });
  await ready(); await ev(`window.__WDS__.bus.runCommand('app.toggleAgent')`);

  const exec = (name,args) => ev(`(async()=>{return (await import('/app/js/agent/tools.js')).createToolExecutor(window.__WDS__).execute(${JSON.stringify(name)},${JSON.stringify(args)},{permission:'full'})})()`);

  const W='window.__WDS__', E=W+'.getEditor()', B=E+'.bridge', D=E+'.iframe.contentDocument', V=E+'.iframe.contentWindow';
  const command=(name,payload)=>ev(`${W}.bus.runCommand(${JSON.stringify(name)},${JSON.stringify(payload)})`);
  const ctrl=async(key,shift=false)=>{
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key,code:'Key'+key.toUpperCase(),windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0),modifiers:2+(shift?8:0)});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:'Key'+key.toUpperCase(),windowsVirtualKeyCode:key.toUpperCase().charCodeAt(0),modifiers:0});await sleep(150);
  };
  await step('HTML 整体绝对大小按像素缩放内部内容，保持位置并支持撤销重做',async()=>{
    const added=await ev(`${B}.insertElement({type:'html',x:600,y:300,w:640,h:320,html:'<div style="width:640px;height:320px;position:relative"><span style="font-size:80px">HTML 内容</span><svg width="200" height="100"><rect width="200" height="100" fill="red"/></svg></div>'})`);
    const id=added.elementId;await ev(`${B}.select(${JSON.stringify(id)})`);await sleep(100);
    assert(await ev(`!document.querySelector('.insp-absolute-size').classList.contains('is-hidden')`));
    await ev(`(()=>{const e=document.querySelector('[aria-label="HTML 整体宽度"]');e.value='320';e.dispatchEvent(new Event('change'))})()`);
    await until(()=>ev(`Math.abs(Number(document.querySelector('[aria-label="HTML 整体高度"]').value)-160)<2`),'绝对大小更新');
    const result=await ev(`(()=>{const el=${D}.querySelector('[data-wpx-el="${id}"]'),r=el.getBoundingClientRect(),s=${D}.querySelector('#wpx-stage').getBoundingClientRect(),c=el.querySelector('svg').getBoundingClientRect();return {w:r.width/s.width*1920,h:r.height/s.width*1920,x:(r.x-s.x)/s.width*1920,y:(r.y-s.y)/s.width*1920,svg:c.width/s.width*1920,layout:el.style.width}})()`);
    assert(Math.abs(result.w-320)<1);assert(Math.abs(result.h-160)<1);assert(Math.abs(result.x-600)<1);assert(Math.abs(result.y-300)<1);assert(Math.abs(result.svg-100)<1);assert.equal(result.layout,'640px');
    await command('app.undo');assert.equal(await ev(`${D}.querySelector('[data-wpx-el="${id}"]').style.scale`),'');
    await command('app.redo');assert(await ev(`${D}.querySelector('[data-wpx-el="${id}"]').style.scale.includes('0.5')`));
    await ev(`${B}.deleteElement(${JSON.stringify(id)})`);
  });
  await step('Agent 截图读取未保存画布与真实像素，返回坐标，支持区域放大并恢复当前页',async()=>{
    const fixture=await ev(`${B}.insertElement({type:'shape',shape:'rect',x:100,y:100,w:240,h:120,fill:'#ff00ff'})`);
    await ev(`${B}.select(${JSON.stringify(fixture.elementId)})`);
    const capture=await exec('deck_capture_slide',{scale:.5});assert(capture.ok,JSON.stringify(capture));
    assert.equal(capture.visual.imageWidth,960);assert.equal(capture.visual.imageHeight,540);assert(capture.images[0].startsWith('data:image/png;base64,'));
    const el=capture.visual.elements.find(e=>e.elementId===fixture.elementId);assert(Math.abs(el.rect.x-100)<1);assert(Math.abs(el.rect.w-240)<1);
    const pixel=await ev(`(async()=>{const i=new Image();i.src=${JSON.stringify(capture.images[0])};await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const t=c.getContext('2d');t.drawImage(i,0,0);return [...t.getImageData(75,75,1,1).data]})()`);
    assert.deepEqual(pixel,[255,0,255,255]);await fs.writeFile(path.join(out,'agent-actual-capture.png'),Buffer.from(capture.images[0].split(',')[1],'base64'));
    const crop=await exec('deck_capture_slide',{region:{x:100,y:100,w:240,h:120},scale:1.5});assert(crop.ok);assert.equal(crop.visual.imageWidth,360);assert.equal(crop.visual.imageHeight,180);
    const other=await exec('deck_capture_slide',{index:2,scale:.5});assert(other.ok,JSON.stringify(other));assert.equal((await ev(`${B}.getState()`)).current,0);
    assert.equal((await ev(`${B}.call('getSelection')`)).elementId,fixture.elementId);
    const bad=await exec('deck_capture_slide',{region:{x:-1,y:0,w:200,h:100}});assert.equal(bad.ok,false);
    await ev(`${B}.deleteElement(${JSON.stringify(fixture.elementId)})`);
  });
  await step('精确大字号覆盖内层旧字号，撤销与重做立即生效',async()=>{
    await ev(`${B}.call('setElementHtml',{elementId:'cover-title',html:'<span style="font-size:24px">字号验收</span>'})`);
    await ev(`${B}.select('cover-title')`);await command('text.fontSize',{size:160});
    assert.equal(await ev(`${V}.getComputedStyle(${D}.querySelector('[data-wpx-el="cover-title"] span')).fontSize`),'160px');
    await command('app.undo');assert.equal(await ev(`${V}.getComputedStyle(${D}.querySelector('[data-wpx-el="cover-title"] span')).fontSize`),'24px');
    await command('app.redo');assert.equal(await ev(`${V}.getComputedStyle(${D}.querySelector('[data-wpx-el="cover-title"] span')).fontSize`),'160px');
  });
  await step('整段换字体覆盖嵌套样式，局部换字体保留其它文字及撤销记录',async()=>{
    const node=`${D}.querySelector('[data-wpx-el="cover-title"]')`;
    const family='wds-font-ma-shan-zheng';
    await ev(`${B}.call('setElementHtml',{elementId:'cover-title',html:'<font face="serif"><span style="font-family:monospace !important">山河</span>如画</font>'})`);
    await ev(`${B}.select('cover-title')`);
    await command('text.fontFamily',{family:`"${family}","马善政毛笔楷书",serif`});
    assert.match(await ev(`${V}.getComputedStyle(${node}.querySelector('span')).fontFamily`),/^wds-font-ma-shan-zheng/);
    assert(await ev(`${D}.fonts.load('64px ${family}','山河如画').then(fonts=>fonts.some(font=>font.status==='loaded'))`));
    await command('app.undo');
    assert.equal(await ev(`${V}.getComputedStyle(${node}.querySelector('span')).fontFamily`),'monospace');
    await ev(`${B}.beginTextEdit('cover-title')`);
    await ev(`(()=>{const r=${D}.createRange(),text=${node}.querySelector('span').firstChild;r.setStart(text,0);r.setEnd(text,1);${V}.getSelection().removeAllRanges();${V}.getSelection().addRange(r)})()`);
    await sleep(80);
    await command('text.fontFamily',{family:'var(--wpx-serif)'});
    assert.equal(await ev(`${node}.querySelector('span span').style.fontFamily`),'var(--wpx-serif)');
    assert.equal(await ev(`${node}.querySelector('span').lastChild.textContent`),'河');
    assert.equal(await ev(`${V}.getSelection().toString()`),'山');
    await command('app.undo');
    assert.equal(await ev(`${node}.querySelector('span').innerHTML`),'山河');
    await ev(`${B}.endTextEdit()`);
  });
  await step('文字局部选区使用真实像素，键盘 Ctrl Z 可撤销且不损坏其它文字',async()=>{
    await ev(`${B}.call('setElementHtml',{elementId:'cover-title',html:'前半后半'})`);
    await ev(`${B}.beginTextEdit('cover-title')`);
    await ev(`(()=>{const d=${D},w=${V},el=d.querySelector('[data-wpx-el="cover-title"]'),r=d.createRange();r.setStart(el.firstChild,0);r.setEnd(el.firstChild,2);w.getSelection().removeAllRanges();w.getSelection().addRange(r)})()`);await sleep(80);
    await command('text.fontSize',{size:120});
    assert.equal(await ev(`${D}.querySelector('[data-wpx-el="cover-title"] span').style.fontSize`),'120px');
    assert.equal(await ev(`${D}.querySelector('[data-wpx-el="cover-title"]').lastChild.textContent`),'后半');
    await ev(`${D}.querySelector('[data-wpx-el="cover-title"]').focus()`);await ctrl('z');
    assert.equal(await ev(`${D}.querySelector('[data-wpx-el="cover-title"]').innerHTML`),'前半后半');
    await ctrl('y');assert.equal(await ev(`${D}.querySelector('[data-wpx-el="cover-title"] span').style.fontSize`),'120px');
  });
  await step('编辑中的行距与字距记录到撤销历史',async()=>{
    await ev(`${B}.beginTextEdit('cover-title')`);await command('text.lineHeight',{value:2.2});
    assert.equal(await ev(`${D}.querySelector('[data-wpx-el="cover-title"]').style.lineHeight`),'2.2');
    await command('app.undo');assert.notEqual(await ev(`${D}.querySelector('[data-wpx-el="cover-title"]').style.lineHeight`),'2.2');
    await ev(`${B}.beginTextEdit('cover-title')`);await command('text.letterSpacing',{value:7});
    assert.equal(await ev(`${D}.querySelector('[data-wpx-el="cover-title"]').style.letterSpacing`),'7px');await command('app.undo');
  });
  await step('双击空白插入一个文本框，直接输入替换占位，撤销删除',async()=>{
    await ev(`${B}.endTextEdit()`);await command('edit.deselect');await sleep(160);
    const before=await ev(`${D}.querySelectorAll('.wpx-el').length`);
    const pt=await ev(`(()=>{const f=${E}.iframe,fr=f.getBoundingClientRect(),s=f.contentDocument.querySelector('#wpx-stage').getBoundingClientRect();return {x:fr.left+s.left+s.width*0.02,y:fr.top+s.top+s.height*.5}})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:2,x:pt.x,y:pt.y});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:2,x:pt.x,y:pt.y});
    await until(()=>ev(`${D}.querySelectorAll('.wpx-el').length===${before+1}&&!!${D}.querySelector('[contenteditable=true]')`),'双击插入');
    await cdp.send('Input.insertText',{text:'空白直接输入'});assert.equal(await ev(`${D}.querySelector('[contenteditable=true]').textContent`),'空白直接输入');
    await ctrl('z');await ctrl('z');assert.equal(await ev(`${D}.querySelectorAll('.wpx-el').length`),before);
  });
  await step('开始栏段落分两行，开始放映入口存在，右键菜单正文紧凑',async()=>{
    const layout=await ev(`(()=>{const p=[...document.querySelectorAll('.rgroup')].find(x=>x.textContent.includes('段落'));return {rows:p?.querySelectorAll('.rrow').length,play:!![...document.querySelectorAll('.rbtn')].find(x=>x.textContent==='放映')}})()`);
    assert.equal(layout.rows,2);assert(layout.play);
    await ev(`${B}.select('cover-title')`);const pt=await ev(`(()=>{const f=${E}.iframe,r=f.getBoundingClientRect();return {x:r.left+r.width*.2,y:r.top+r.height*.4}})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',x:pt.x,y:pt.y});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',x:pt.x,y:pt.y});
    await until(()=>ev(`!!document.querySelector('.ctx-menu-text')`),'右键菜单');
    const font=await ev(`(()=>{const s=getComputedStyle(document.querySelector('.ctx-menu-text'));return {size:s.fontSize,spacing:s.letterSpacing,padding:s.padding}})()`);
    assert.equal(font.size,'13px');assert(['normal','0px'].includes(font.spacing));assert.equal(font.padding,'0px');await shot('editor-refined-context');await ev(`${W}.bus.emit('ui:closeMenus')`);
  });
  await step('飞入内容可改文字与方向，时间线具有 Agent 草稿入口',async()=>{
    await command('app.toggleTimeline');await until(()=>ev(`!document.querySelector('#timeline-panel').classList.contains('hidden')`),'时间线面板');
    await command('timeline.addOverlay',{kind:'ripple'});
    await ev(`void ${W}.bus.runCommand('timeline.addOverlay',{kind:'fly'})`);
    await until(()=>ev(`!!document.querySelector('.tl-effect-form')`),'飞入内容表单');
    await ev(`document.querySelector('[aria-label="特效内容"]').value='可以编辑的飞入文字';document.querySelector('[aria-label="飞入方向"]').value='top';[...document.querySelectorAll('.tl-effect-form button')].find(x=>x.textContent.includes('生成关键帧')).click();document.querySelector('.modal-foot .btn--primary').click()`);
    await until(()=>ev(`${D}.querySelector('[data-wpx-tl="fly"]')?.textContent.includes('可以编辑')`),'文字特效图层');
    const fly=(await ev(`${B}.call('getTimeline')`)).timeline.tracks.find(t=>t.selector.includes('fly'));
    assert(fly.keyframes.every(k=>k.id));assert.equal(new Set(fly.keyframes.map(k=>k.id)).size,fly.keyframes.length);
    const before=await ev(`${L}.messages.length`);await ev(`document.querySelector('#timeline-panel [data-act=agent]').click()`);
    assert(await ev(`document.querySelector('.agw-input').value.includes('我的要求')`));assert.equal(await ev(`${L}.messages.length`),before);
    await shot('editor-timeline-content');
  });
  const custom={id:'ai-svg',name:'AI SVG 任意特效',kind:'overlay',selector:'[data-wpx-tl="ai-svg"]',html:'<div style="position:absolute;left:800px;top:300px;width:320px;height:320px;opacity:0;z-index:90"><svg viewBox="0 0 100 100"><path d="M50 5 95 90 5 90Z" fill="#90d7ff"/></svg><span>AI_EFFECT</span></div>',css:'[data-wpx-tl="ai-svg"] span{color:#90d7ff}',keyframes:[{t:0,props:{opacity:0,scale:.2}},{t:500,props:{opacity:1,scale:1,rotate:90}},{t:1500,props:{opacity:0,scale:1.5}}]};
  await step('真实多模态链路收到页面图片，Agent 精确调整后再次截图，刷新保留视觉记录',async()=>{
    const before=await ev(`${B}.call('getVisualState',{})`),r=before.elements.find(e=>e.elementId==='cover-title').rect;
    await input('VISUAL_TEST 查看并细调标题');await idle();
    const captures=await ev(`${L}.messages.filter(m=>m.name==='deck_capture_slide')`);assert.equal(captures.length,2);assert(captures.every(m=>m.images?.[0].startsWith('data:image/png;base64,')));
    const after=await ev(`${B}.call('getVisualState',{})`),next=after.elements.find(e=>e.elementId==='cover-title').rect;
    assert(Math.abs(next.x-r.x-12)<1);assert(Math.abs(next.y-r.y-8)<1);
    assert(await ev(`document.querySelector('.agw-final').textContent.includes('精确右移')`));
    const origin=await ev('performance.timeOrigin');await cdp.send('Page.reload');await until(()=>ev(`performance.timeOrigin!==${origin}`),'视觉记录刷新');await ready();
    await until(()=>ev(`${L}.messages.filter(m=>m.name==='deck_capture_slide'&&m.images?.length).length===2`),'视觉证据持久化');
    await newChat();await ev(`document.querySelector('#app').dataset.agent==='open'||window.__WDS__.bus.runCommand('app.toggleAgent')`);
  });
  await step('Agent 可创建全新 SVG 特效，保留其它轨道，支持撤销与重做',async()=>{
    const tl=(await ev(`${B}.call('getTimeline')`)).timeline;tl.tracks.push(custom);
    assert((await exec('deck_set_timeline',{timeline:tl})).ok);await sleep(250);
    assert(await ev(`!!${D}.querySelector('[data-wpx-tl="ai-svg"] svg')`));
    assert((await ev(`${B}.call('getTimeline')`)).timeline.tracks.some(t=>t.selector.includes('fly')));
    await command('app.undo');assert.equal(await ev(`!!${D}.querySelector('[data-wpx-tl="ai-svg"]')`),false);
    await command('app.redo');assert(await ev(`!!${D}.querySelector('[data-wpx-tl="ai-svg"] svg')`));
    await ev(`${E}.saveNow({reason:'qa'})`);
  });
  let nativeHtml='',rawHtml='';
  await step('极高思考启用三模型协作，工具与文字交错，检查退回后完成并统一折叠',async()=>{
    await command('agent.openSettings');await until(()=>ev(`!!document.querySelector('.ais-collaboration')`),'子代理设置');
    for(const [label,model] of [['设计与关键代码','team-designer'],['代码实现','team-worker'],['检查','team-reviewer']]) {
      await ev(`(()=>{const el=document.querySelector('[aria-label="${label}模型"]');el.value=${JSON.stringify(model)};el.dispatchEvent(new Event('input'))})()`);
    }
    await ev(`document.querySelector('.ais-dialog .modal-foot .btn--primary').click()`);await until(()=>ev(`!document.querySelector('.ais-dialog')`),'保存三角色配置');
    await ev(`document.querySelector('.agw-effort').click()`);await ev(`[...document.querySelectorAll('.agw-menu-item')].find(b=>b.textContent.includes('极高')).click()`);
    assert.equal(await ev(`${L}.reasoningEffort`),'xhigh');assert.equal((await json(base,'/api/settings')).agent.collaboration.implement.model,'team-worker');
    assert.equal(await ev(`getComputedStyle(document.querySelector('.agw-model')).display`),'none');
    assert(await ev(`document.querySelector('.agw-team-settings').getBoundingClientRect().width>0`));
    await ev(`document.querySelector('.agw-team-settings').click()`);await until(()=>ev(`!!document.querySelector('.ais-collaboration')`),'协作配置入口');
    assert.equal(await ev(`document.querySelector('[aria-label="代码实现模型"]').value`),'team-worker');
    await ev(`[...document.querySelectorAll('.ais-dialog .modal-foot button')].find(b=>b.textContent==='取消').click()`);await until(()=>ev(`!document.querySelector('.ais-dialog')`),'关闭协作配置');
    await input('TEAM_TEST 协作完成页面');
    await until(()=>ev(`document.querySelector('.agw-turn[data-running=true] .agw-prose')?.textContent.includes('读取工程')&&!!document.querySelector('.agw-operation')`),'实时输出顺序');
    assert(await ev(`(()=>{const t=document.querySelector('.agw-turn[data-running=true]');const a=t.querySelector('.agw-prose'),b=t.querySelector('.agw-operation');return !!(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING)&&getComputedStyle(a).display!=='none'})()`));
    await idle();
    const team=(await json('http://127.0.0.1:'+modelPort,'/test/team-stats'));assert(team.some(r=>r.model==='team-worker'));assert(team.some(r=>r.model==='team-reviewer'));assert.equal(team.at(-1).phase,'final');
    assert(team.filter(r=>r.phase==='review').every(r=>!r.tools.includes('deck_set_text')));
    assert.equal(await ev(`${L}.messages.filter(m=>m.agentRole?.role==='review'&&m.name==='deck_capture_slide'&&m.images?.length).length`),2);
    assert(await ev(`${D}.body.textContent.includes('TEAM_IMPLEMENTED')&&${D}.body.textContent.includes('TEAM_FIXED')`));
    const view=await ev(`(()=>{const t=document.querySelector('.agw-turn'),l=t.querySelector('.agw-ledger');return {collapsed:!l.open,final:t.querySelector(':scope > .agw-final').textContent,parts:l.querySelectorAll('.agw-prose').length,roles:[...l.querySelectorAll('.agw-role')].map(x=>x.dataset.role)}})()`);
    assert(view.collapsed);assert(view.final.includes('三角色协作已完成'));assert(view.parts>3);assert(view.roles.includes('review'));
    await ev(`document.querySelector('.agw-ledger').open=true`);await shot('agent-collaboration-process');
    const origin=await ev('performance.timeOrigin');await cdp.send('Page.reload');await until(()=>ev(`performance.timeOrigin!==${origin}`),'页面重新载入');await ready();
    await until(()=>ev(`!!document.querySelector('.agw-final')`),'协作对话恢复');await command('app.toggleAgent');
    assert(await ev(`document.querySelector('.agw-final').textContent.includes('三角色协作')`));assert.equal(await ev(`${L}.messages.find(m=>m.collaboration)?.collaboration.phase`),'done');
    assert.equal(await ev(`getComputedStyle(document.querySelector('.agw-model')).display`),'none');
    await shot('agent-collaboration-collapsed');
    await ev(`document.querySelector('.agw-effort').click()`);await ev(`[...document.querySelectorAll('.agw-menu-item')].find(b=>b.textContent.trim()==='中').click()`);
    assert(await ev(`document.querySelector('.agw-model').getBoundingClientRect().width>0`));
    assert.equal(await ev(`getComputedStyle(document.querySelector('.agw-team-settings')).display`),'none');
  });
  await step('原创目录支持任意 HTML SVG CSS，绑定稳定页面 ID 并可视检查',async()=>{
    const html='<h1 style="position:absolute;left:120px;top:130px;font-size:100px">Research atlas</h1>'+[0,1].map(i=>`<button class="wpx-el atlas-node" data-wpx-el="atlas-${i}" data-wds-target="{{target:${i}}}" data-wpx-action="go-id:{{target:${i}}}" style="position:absolute;left:${180+i*800}px;top:${380+i*90}px;width:600px;height:180px;font-size:48px">${i?'Observation':'Principle'}</button>`).join('');
    assert((await exec('deck_set_navigation',{index:1,style:'custom',html,css:'.wds-nav-custom .atlas-node{border:2px solid currentColor;background:transparent;color:inherit;transition:transform .3s}.wds-nav-custom .atlas-node:hover{transform:translateY(-12px)}@media(prefers-reduced-motion:reduce){.wds-nav-custom .atlas-node{transition:none}}',chapters:[{title:'Principle',slideIndex:2},{title:'Observation',slideIndex:4}]})).ok);
    assert(await ev(`${D}.querySelector('[data-wds-navigation="custom"]')!==null`));
    const cap=await exec('deck_capture_slide',{index:1,scale:.5});assert(cap.ok,JSON.stringify(cap));await fs.writeFile(path.join(out,'agent-original-navigation.png'),Buffer.from(cap.images[0].split(',')[1],'base64'));
    assert(cap.visual.elements.some(e=>e.elementId==='atlas-0'));
    await ev(`${E}.saveNow({reason:'qa'})`);
  });
  await step('保存并重开后自定义时间线可恢复，导出包含离线特效与放映工具',async()=>{
    await cdp.send('Page.reload');await ready();
    await until(()=>ev(`!!${D}.querySelector('[data-wpx-tl="ai-svg"] svg')`),'重开自定义特效');
    nativeHtml=await (await fetch(base+'/api/projects/'+project.id+'/export')).text();
    assert(nativeHtml.includes('wds-present-tools'));assert(nativeHtml.includes('AI_EFFECT'));assert(!nativeHtml.includes('src="/editor/presentation-tools.js"'));
  });
  await step('工程 CSS 隐藏活动页时，编辑器与放映运行时均恢复真实画面',async()=>{
    const check=async(winExpr,docExpr)=>ev(`(()=>{const w=${winExpr},d=${docExpr},s=d.createElement('style');s.textContent='#wpx-app,#wpx-stage,.wpx-slide.is-active,.wpx-slide.is-active>.wpx-canvas{display:none!important;visibility:hidden!important;opacity:0!important}';d.head.append(s);w.__WPX__.ensureVisible();const slide=d.querySelector('.wpx-slide.is-active'),canvas=slide?.querySelector('.wpx-canvas'),result={slide:!!slide,slideDisplay:getComputedStyle(slide).display,slideVisibility:getComputedStyle(slide).visibility,slideOpacity:getComputedStyle(slide).opacity,canvasDisplay:getComputedStyle(canvas).display,canvasVisibility:getComputedStyle(canvas).visibility,canvasOpacity:getComputedStyle(canvas).opacity,stageWidth:d.querySelector('#wpx-stage').getBoundingClientRect().width};s.remove();return result})()`);
    const edit=await check(V,D);assert(edit.slide);assert.equal(edit.slideDisplay,'block');assert.equal(edit.slideVisibility,'visible');assert.equal(edit.slideOpacity,'1');assert.equal(edit.canvasDisplay,'block');assert.equal(edit.canvasVisibility,'visible');assert.equal(edit.canvasOpacity,'1');assert(edit.stageWidth>0);
    await command('app.presentInline');
    await until(()=>ev(`!!document.querySelector('.present-frame')?.contentWindow?.__WPX__?.ready`),'放映运行时');
    const present=await check('document.querySelector(".present-frame").contentWindow','document.querySelector(".present-frame").contentDocument');
    assert(present.slide);assert.equal(present.slideDisplay,'block');assert.equal(present.slideVisibility,'visible');assert.equal(present.slideOpacity,'1');assert.equal(present.canvasDisplay,'block');assert.equal(present.canvasVisibility,'visible');assert.equal(present.canvasOpacity,'1');assert(present.stageWidth>0);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  });
  await step('原稿模式字体与字号可撤销和保存，时间线支持自定义 SVG',async()=>{
    const content='<!doctype html><html><head><style>body{margin:0;background:#eee}.slide{position:absolute;width:100vw;height:100vh}.slide:not(.active){display:none}h1{font-size:30px}#stage{position:relative;width:100vw;height:100vh}</style></head><body><div id="stage"><section class="slide active"><h1><span style="font-size:20px">原稿标题</span></h1></section><section class="slide"><h1>第二页</h1></section></div><script>document.addEventListener("keydown",e=>{if(e.key==="ArrowRight"||e.key==="ArrowLeft"){document.querySelectorAll(".slide").forEach(x=>x.classList.toggle("active"));location.hash=document.querySelector(".slide.active")===document.querySelector(".slide")?"1":"2";}})</script></body></html>';
    const raw=(await json(base,'/api/projects/import',{name:'Refined raw',fileName:'raw.html',content,mode:'raw'})).project;
    await ev(`${W}.navigate('#/p/'+${JSON.stringify(raw.id)})`);await ready();
    await until(()=>ev(`${W}.store.get().deck.raw && ${L}.projectId===${JSON.stringify(raw.id)}`),'raw就绪');
    const id=await ev(`${D}.querySelector('h1').dataset.wpxEl`);await ev(`${B}.select(${JSON.stringify(id)})`);await command('text.fontSize',{size:180});
    assert.equal(await ev(`${V}.getComputedStyle(${D}.querySelector('h1 span')).fontSize`),'180px');await ev(`${E}.saveNow({reason:'qa'})`);
    await command('app.undo');assert.equal(await ev(`${V}.getComputedStyle(${D}.querySelector('h1 span')).fontSize`),'20px');
    await command('app.redo');await ev(`${E}.saveNow({reason:'qa'})`);
    const family='wds-font-boutique-bitmap';
    await command('text.fontFamily',{family});
    assert.equal(await ev(`${V}.getComputedStyle(${D}.querySelector('h1 span')).fontFamily`),family);
    await command('app.undo');
    assert.notEqual(await ev(`${V}.getComputedStyle(${D}.querySelector('h1 span')).fontFamily`),family);
    await command('app.redo');await ev(`${E}.saveNow({reason:'qa'})`);
    assert((await exec('deck_set_timeline',{timeline:{version:2,duration:3200,pages:[{index:0,start:0,duration:1600},{index:1,start:1600,duration:1600}],tracks:[custom]}})).ok);
    const capture=await exec('deck_capture_slide',{scale:.5});assert(capture.ok,JSON.stringify(capture));assert(capture.visual.elements.some(e=>e.elementId===id));
    assert(await ev(`!!${D}.querySelector('[data-wpx-tl="ai-svg"] svg')`));await ev(`${E}.saveNow({reason:'qa'})`);
    rawHtml=await (await fetch(base+'/api/projects/'+raw.id+'/export')).text();assert(rawHtml.includes('AI_EFFECT'));
    assert.equal(rawHtml.match(/data:font\/ttf;base64,/g)?.length,1);
  });
  const drawStroke=async(x,y,dx=140,dy=50,touch=false)=>{
    if(touch){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,radiusX:2,radiusY:2,force:.6}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx,y:y+dy,radiusX:2,radiusY:2,force:.6}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
    else {await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+dx,y:y+dy,button:'left',buttons:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+dx,y:y+dy,button:'left',buttons:0});}await sleep(100);
  };
  for(const [kind,html] of [['native',nativeHtml],['raw',rawHtml]]) {
    await step(kind+' 导出 HTML 可直接从 file 打开，默认隐藏鼠标，显示 SVG 工具栏',async()=>{
      const file=path.join(out,'refined-'+kind+'.html');await fs.writeFile(file,html);await cdp.send('Page.navigate',{url:pathToFileURL(file).href});
      await until(()=>ev(`!!window.__WDS_PRESENTATION__?.getState && !!document.querySelector('[data-wpx-tl="ai-svg"] svg')`),'离线放映');
      assert.equal(await ev(`document.documentElement.dataset.wdsCursor`),'hide');assert.equal(await ev(`document.querySelectorAll('#wds-present-tools button svg').length`),9);
      assert.equal(await ev(`getComputedStyle(document.querySelector('#wds-present-tools')).position`),'fixed');
      if(kind==='native'){
        await ev(`window.__WPX__.go(1,{instant:true})`);
        await ev(`new Promise(resolve=>{const off=window.__WPX__.on('slidechange',s=>{if(s.index===2){off();resolve();}});document.querySelector('[data-wpx-el="atlas-0"]').click();})`);
        assert.equal(await ev(`window.__WPX__.getState().current`),2);
        await ev(`window.__WPX__.go(0,{instant:true})`);
      }
      await ev(`document.querySelector('[data-tool=cursor]').click()`);assert.equal(await ev(`document.documentElement.dataset.wdsCursor`),'show');
      await ev(`document.querySelector('[data-tool=cursor]').click()`);assert.equal(await ev(`document.documentElement.dataset.wdsCursor`),'hide');
    });
    await step(kind+' 鼠标与手触画笔、橡皮、逐页笔迹、清除和退出均有效',async()=>{
      await ev(`document.querySelector('[data-tool=pen]').click()`);await drawStroke(400,330);assert.equal(await ev(`__WDS_PRESENTATION__.getState().strokes`),1);
      await drawStroke(500,400,100,80,true);assert.equal(await ev(`__WDS_PRESENTATION__.getState().strokes`),2);
      await ev(`document.querySelector('[data-tool=eraser]').click()`);await drawStroke(430,345,100,0);assert.equal(await ev(`__WDS_PRESENTATION__.getState().strokes`),3);
      await ev(`document.querySelector('[data-tool=next]').click()`);await until(()=>ev(`__WDS_PRESENTATION__.getState().page===1`),'下一页');assert.equal(await ev(`__WDS_PRESENTATION__.getState().strokes`),0);
      await ev(`document.querySelector('[data-tool=prev]').click()`);await until(()=>ev(`__WDS_PRESENTATION__.getState().page===0`),'上一页');assert.equal(await ev(`__WDS_PRESENTATION__.getState().strokes`),3);
      await ev(`document.querySelector('[data-tool=clear]').click()`);assert.equal(await ev(`__WDS_PRESENTATION__.getState().strokes`),0);
      await shot('presentation-tools-'+kind);await ev(`document.querySelector('[data-tool=exit]').click()`);
      assert.equal(await ev(`getComputedStyle(document.querySelector('#wds-present-tools')).display`),'none');assert.equal(await ev(`document.documentElement.dataset.wdsCursor`),'show');assert(await ev(`__WDS_PRESENTATION__.getState().exited`));
    });
  }
  await step('无 JavaScript 异常',async()=>assert.deepEqual(report.errors.filter(e=>!/fullscreen|Permissions policy/i.test(e)),[]));
} catch (error) { report.fatal=error.stack;console.error(error.stack);process.exitCode=1;try{await shot('editor-refinements-failure');}catch{} }
finally { await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'editor-refinements-report.json'),JSON.stringify(report,null,2));cdp?.ws.close();for(const child of children.reverse())child.kill();console.log(report.steps.filter(s=>s.ok).length+'/'+report.steps.length+' checks passed'); }
