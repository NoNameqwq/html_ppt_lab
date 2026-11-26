/* Real-browser acceptance for the Agent. Isolated data, local mock, no real API keys. */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {pptxFixture} from './pptx-fixture.mjs';
import { qaSkillPicker } from './qa-skill-picker.mjs';

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
  const settings = { providers: [{ id: 'workspace-test', name: 'Workspace Test', baseUrl: 'http://127.0.0.1:' + modelPort + '/v1', wire: 'openai', apiKey: 'test-only', model: 'workspace-test', models: [{ id: 'workspace-test', contextLength: 131072, maxOutput: 8192, tools: true, vision: true }] }], agent: { maxTokens: 8192 } };
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
  await step('聊天底部 Skill 快捷多选、搜索、持久化及窄屏主题', () => qaSkillPicker({ ev, cdp, until, shot, mode: 'backend' }));

  const exec = (name,args) => ev(`(async()=>{return (await import('/app/js/agent/tools.js')).createToolExecutor(window.__WDS__).execute(${JSON.stringify(name)},${JSON.stringify(args)},{permission:'full'})})()`);

  await step('工作台和 Agent 可打开 127.0.0.1 页面并截图', async () => {
    await ev(`void window.__WDS__.bus.runCommand('agent.openBrowser')`);
    await until(() => ev(`document.querySelector('.wds-browser-status')?.textContent.includes('输入网址')`), '浏览器对话框可用');
    await ev(`(() => {
      const form = document.querySelector('.wds-browser-address');
      form.querySelector('input').value = ${JSON.stringify('127.0.0.1:' + appPort + '/')};
      form.requestSubmit();
    })()`);
    await until(() => ev(`document.querySelector('.wds-browser-preview')?.getAttribute('src')?.startsWith('data:image/jpeg;base64,')`), '本地网页截图');
    const screenshot = await exec('browser_use', { action: 'screenshot' });
    assert.equal(screenshot.url, base + '/');
    assert.match(screenshot.images[0], /^data:image\/jpeg;base64,/);
    assert((await exec('browser_use', { action: 'close' })).ok);
    await ev(`document.querySelector('.wds-browser').closest('.modal').querySelector('.modal-close').click()`);
    await until(() => ev(`!document.querySelector('.wds-browser')`), '浏览器对话框关闭');
  });

  await step('画布可加载全部字体，离线演示只嵌入使用的字重', async () => {
    const family = 'wds-font-boutique-bitmap';
    const registry = await exec('fonts_list', { text: '江山如画' });
    assert.equal(registry.fonts.filter(font => font.bundled).length, 23);
    const deck = await json(base, '/api/projects', { name: '字体验收', templateId: 'blank' });
    const rootUrl = base + '/p/' + encodeURIComponent(deck.project.id) + '/index.html';
    const projectApi = base + '/api/projects/' + encodeURIComponent(deck.project.id);
    const file = await json(base, '/api/projects/' + encodeURIComponent(deck.project.id) + '/file');
    const marker = `<div id="font-test" style="font:700 64px ${family}">江山如画</div>`;
    const update = await fetch(projectApi + '/file', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'index.html', content: file.content.replace('</body>', marker + '</body>') }),
    });
    assert(update.ok);
    await ev(`(() => {
      const frame = document.createElement('iframe');
      frame.id = 'font-fixture';
      frame.src = ${JSON.stringify(rootUrl + '?wpx=edit')};
      document.body.append(frame);
    })()`);
    await until(() => ev(`!!document.querySelector('#font-fixture')?.contentDocument?.querySelector('#font-test')`), '字体验证画布');
    const families = await ev(`[...document.querySelector('#font-fixture').contentDocument.fonts]
      .filter(face => face.family.startsWith('wds-font-')).map(face => face.family + ':' + face.weight)`);
    assert.equal(families.length, 35);
    for (const name of families) {
      const status = await ev(`(async () => {
        const page = document.querySelector('#font-fixture').contentDocument;
        const face = [...page.fonts].find(face => face.family + ':' + face.weight === ${JSON.stringify(name)});
        try { await face.load(); } catch (error) { return error.message; }
        return face.status;
      })()`);
      assert.equal(status, 'loaded', name);
    }
    const html = await (await fetch(projectApi + '/export')).text();
    assert.equal(html.match(/data:font\/ttf;base64,/g)?.length, 1);
    assert.match(html, /font-weight:700;font-style:normal;font-display:swap/);
    await ev(`document.querySelector('#font-fixture').remove()`);
    const offlineFile = path.join(out, 'offline-font.html');
    await fs.writeFile(offlineFile, html);
    const offline = await cdp.send('Target.createTarget', { url: pathToFileURL(offlineFile).href, background: true });
    const offlineTarget = await until(async () => (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).find(p => p.id === offline.targetId), '离线字体验证页');
    const offlineCdp = new CDP(offlineTarget.webSocketDebuggerUrl);
    try {
      await offlineCdp.open();
      await until(() => offlineCdp.eval("!!document.querySelector('#font-test')"), '离线测试文本');
      assert.deepEqual(await offlineCdp.eval(`document.fonts.load('700 64px ${family}', '江山如画').then(faces => faces.map(face => [face.family, face.weight, face.status]))`), [[family, '700', 'loaded']]);
    } finally {
      offlineCdp.ws?.close();
      await cdp.send('Target.closeTarget', { targetId: offline.targetId });
    }
  });

  await step('统一 API 设置切换保留草稿，模型获取和搜索测试不保存，取消不启用生图', async () => {
    const before = await json(base, '/api/settings');
    await ev(`window.__WDS__.bus.runCommand('agent.openSettings')`);
    await until(() => ev(`!!document.querySelector('.ais-dialog')`), '统一设置窗口');
    assert.deepEqual(await ev(`[...document.querySelectorAll('.ais-sections [role="tab"]')].map(t=>t.id)`), ['ais-nav-chat','ais-nav-search','ais-nav-image','ais-nav-backup','ais-nav-instructions']);
    await ev(`(()=>{const b=document.querySelector('[aria-label="对话 Base URL"]'),k=document.querySelector('[aria-label="对话 API Key"]');b.value=${JSON.stringify('http://127.0.0.1:'+modelPort+'/v1')};b.dispatchEvent(new Event('input'));k.value='draft-chat-key';k.dispatchEvent(new Event('input'));document.querySelector('#ais-nav-search').click();document.querySelector('[aria-label="搜索 Base URL"]').value=${JSON.stringify('http://127.0.0.1:'+modelPort)};document.querySelector('[aria-label="搜索 API Key"]').value='draft-search-key';[...document.querySelectorAll('.ais-search-form button')].find(b=>b.textContent==='测试搜索连接').click();})()`);
    await until(()=>ev(`document.querySelector('.ais-search-form').textContent.includes('连接成功')`),'草稿搜索测试');
    await ev(`document.querySelector('#ais-nav-image').click();document.querySelector('[aria-label="生图服务地址"]').value=${JSON.stringify('http://127.0.0.1:'+modelPort+'/v1')};document.querySelector('[aria-label="生图 API Key"]').value='fake-image-secret';document.querySelector('[aria-label="生图 API Key"]').dispatchEvent(new Event('input'));document.querySelector('[aria-label="允许 Agent 使用生图服务"]').checked=true;`);
    await until(()=>ev(`document.querySelector('.ais-image-form').textContent.includes('已发现 1 个生图模型')`),'草稿自动获取生图模型');
    await ev(`document.querySelector('#ais-nav-chat').click()`);
    assert.equal(await ev(`document.querySelector('[aria-label="对话 API Key"]').value`),'draft-chat-key');
    await ev(`[...document.querySelectorAll('.ais-pane button')].find(b=>b.textContent==='测试对话连接').click()`);
    await until(()=>ev(`document.querySelector('.ais-pane .ais-status').textContent.includes('连接成功')`),'草稿对话测试');
    await ev(`document.querySelector('#ais-nav-search').click()`);
    assert.equal(await ev(`document.querySelector('[aria-label="搜索 API Key"]').value`),'draft-search-key');
    assert.equal(await ev(`document.querySelectorAll('.ais-dialog').length`),1);
    await shot('settings-unified-search');
    assert.deepEqual(await json(base,'/api/settings'),before);
    await ev(`[...document.querySelectorAll('.ais-dialog .modal-foot button')].find(b=>b.textContent==='取消').click()`); await sleep(180);
    assert.deepEqual(await json(base,'/api/settings'),before);
    assert.equal((await json('http://127.0.0.1:'+modelPort,'/test/image-stats')).generatedImages,0);
  });
  await step('生图模型发现处理失败和旧请求竞态，旧凭据结果不会覆盖新结果', async () => {
    await ev(`window.__WDS__.bus.runCommand('agent.openImageSettings')`);
    await until(()=>ev(`!!document.querySelector('.ais-image-form')`),'生图分页');
    await ev(`document.querySelector('[aria-label="生图服务地址"]').value=${JSON.stringify('http://127.0.0.1:'+modelPort+'/v1')};document.querySelector('[aria-label="生图 API Key"]').value='slow-key';document.querySelector('.ais-image-form .ais-actions button').click()`);
    await sleep(120);
    await ev(`document.querySelector('[aria-label="生图 API Key"]').value='fake-image-secret';document.querySelector('[aria-label="生图 API Key"]').dispatchEvent(new Event('input'))`);
    await until(()=>ev(`document.querySelector('.ais-image-form').textContent.includes('已发现 1 个生图模型')`),'新凭据模型列表'); await sleep(600);
    assert.equal(await ev(`document.querySelector('#ais-image-models option').value`),'gpt-image-1.5');
    await ev(`document.querySelector('[aria-label="生图 API Key"]').value='bad-key';document.querySelector('[aria-label="生图 API Key"]').dispatchEvent(new Event('input'))`);
    await until(()=>ev(`document.querySelector('.ais-image-form .ais-status').textContent.includes('HTTP 401')`),'模型获取失败提示');
    assert.equal(await ev(`document.querySelectorAll('#ais-image-models option').length`),0);
    await ev(`[...document.querySelectorAll('.ais-dialog .modal-foot button')].find(b=>b.textContent==='取消').click()`); await sleep(180);
    const before=await json(base,'/api/settings');
    const failed=await fetch(base+'/api/settings/user',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent:{temperature:1.2},imageGeneration:{enabled:true,baseUrl:'',clearKey:true}})});
    assert.equal(failed.status,400);assert.deepEqual(await json(base,'/api/settings'),before);
    const failedModels=await fetch(base+'/api/ai/models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({providerId:'workspace-test',baseUrl:'http://127.0.0.1:'+modelPort+'/v1',apiKey:'bad-key'})});
    assert.equal(failedModels.status,502);assert.equal((await failedModels.json()).models,undefined);
  });
  await step('聊天底部上下文详情支持鼠标、键盘、深浅主题和窄屏，不超出视口', async () => {
    assert.deepEqual((await ev(`${L}.skills`)).sort(),['deck-narrative','html-deck-craft','motion-design']);
    await ev(`window.__WDS__.bus.runCommand('agent.fullscreen',{open:true})`);await sleep(260);
    const rect=await ev(`(()=>{const r=document.querySelector('.agw-context-button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x,y:rect.y});await sleep(180);
    assert(await ev(`!document.querySelector('.agw-context-detail').hidden`));
    assert.equal(await ev(`document.querySelectorAll('.agw-context-row').length`),3);
    const usage=await ev(`${L}.getState().context`);assert.equal(Object.values(usage.breakdown).reduce((a,b)=>a+b,0),usage.tokens);assert(usage.breakdown.tools>0);
    assert.equal(await ev(`document.querySelector('.agw-context-ring .is-used').getAttribute('stroke-dashoffset')`),String(100-usage.percent));
    assert.notEqual(await ev(`getComputedStyle(document.querySelector('.agw-context-ring .is-used')).stroke`),'none');
    await shot('context-usage-desktop');
    const color=await ev(`getComputedStyle(document.querySelector('.agw-context-detail')).backgroundColor`);
    await ev(`window.__WDS__.bus.runCommand('app.toggleTheme')`);await sleep(160);
    assert.notEqual(await ev(`getComputedStyle(document.querySelector('.agw-context-detail')).backgroundColor`),color);
    await shot('context-usage-theme');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:false});await sleep(150);
    await ev(`document.querySelector('.agw-context-button').focus()`);
    const box=await ev(`(()=>{const r=document.querySelector('.agw-context-detail').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()`);
    assert(box.left>=0&&box.right<=375&&box.top>=0&&box.bottom<=812,JSON.stringify(box));
    await shot('context-usage-mobile');
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert(await ev(`document.querySelector('.agw-context-detail').hidden`));
    assert(await ev(`document.querySelector('#agent-panel').dataset.fullscreen==='true'`));
    await ev(`window.__WDS__.bus.runCommand('agent.openImageSettings')`);await until(()=>ev(`!!document.querySelector('.ais-dialog')`),'窄屏设置');
    assert(await ev(`(()=>{const r=document.querySelector('.ais-dialog').getBoundingClientRect();return r.left>=0&&r.right<=375&&r.top>=0&&r.bottom<=812})()`));
    await shot('settings-unified-mobile');
    await ev(`[...document.querySelectorAll('.ais-dialog .modal-foot button')].find(b=>b.textContent==='取消').click()`);await sleep(180);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await ev(`window.__WDS__.bus.runCommand('app.toggleTheme');window.__WDS__.bus.runCommand('agent.fullscreen',{open:false})`);await sleep(260);
  });
  await step('统一保存三个分页的配置，重新打开时空白密钥输入保留已存密钥', async () => {
    await ev(`window.__WDS__.bus.runCommand('agent.openSettings')`);await until(()=>ev(`!!document.querySelector('.ais-dialog')`),'统一保存设置');
    await ev(`document.querySelector('.ais-tab[data-pid="workspace-test"]').click();document.querySelector('[aria-label="对话 API Key"]').value='updated-chat-secret';document.querySelector('[aria-label="对话 API Key"]').dispatchEvent(new Event('input'));document.querySelector('#ais-nav-search').click();document.querySelector('[aria-label="搜索服务"]').value='tavily';document.querySelector('[aria-label="搜索服务"]').dispatchEvent(new Event('change'));document.querySelector('[aria-label="搜索 Base URL"]').value=${JSON.stringify('http://127.0.0.1:'+modelPort)};document.querySelector('[aria-label="搜索 API Key"]').value='saved-search-secret';document.querySelector('[aria-label="搜索结果条数"]').value='7';document.querySelector('#ais-nav-image').click();document.querySelector('[aria-label="生图服务地址"]').value=${JSON.stringify('http://127.0.0.1:'+modelPort+'/v1')};document.querySelector('[aria-label="生图 API Key"]').value='saved-image-secret';document.querySelector('[aria-label="生图 API Key"]').dispatchEvent(new Event('input'))`);
    await until(()=>ev(`document.querySelector('.ais-image-form').textContent.includes('已发现 1 个生图模型')`),'保存前发现模型');
    await ev(`[...document.querySelectorAll('.ais-dialog .modal-foot button')].find(b=>b.textContent==='保存').click()`);
    await until(()=>ev(`!document.querySelector('.ais-dialog')`),'统一保存完成');
    const saved=await json(base,'/api/settings');assert.equal(saved.search.provider,'tavily');assert.equal(saved.search.maxResults,7);assert(saved.search.keySet);assert(saved.imageGeneration.configured);assert.equal(saved.imageGeneration.enabled,false);assert.equal(saved.imageGeneration.model,'auto');
    assert.equal(saved.imageGeneration.models[0].id,'gpt-image-1.5');assert(!JSON.stringify(saved).includes('saved-image-secret'));assert(!JSON.stringify(saved).includes('updated-chat-secret'));
    await ev(`window.__WDS__.bus.runCommand('agent.openImageSettings')`);await until(()=>ev(`!!document.querySelector('.ais-dialog')`),'再次打开设置');
    assert.equal(await ev(`document.querySelector('[aria-label="生图 API Key"]').value`),'');
    await ev(`[...document.querySelectorAll('.ais-dialog .modal-foot button')].find(b=>b.textContent==='保存').click()`);await until(()=>ev(`!document.querySelector('.ais-dialog')`),'保留密钥保存');
    assert((await json(base,'/api/settings')).imageGeneration.configured);
    assert.equal((await json(base,'/api/image-models',{})).source,'upstream');
    assert.equal((await json(base,'/api/image-models?baseUrl=https%3A%2F%2Funused.example')).source,'upstream');
  });

  await step('分组技能发现、开源来源与页内知识示例', async () => {
    const catalog = await json(base,'/api/skills');
    assert.deepEqual(catalog.skills.filter(s=>s.default).map(s=>s.id).sort(),['deck-narrative','html-deck-craft','motion-design']);
    assert(!catalog.skills.some((s)=>s.id==='README')); assert(catalog.skills.find((s)=>s.id==='pptx-visual-composition').source.includes('anthropics'));
    assert.equal(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelectorAll('.wpx-slide').length`),8);
    assert.equal(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelectorAll('.katex').length`),2);
  });
  await step('整套生成在页面内渲染公式、SVG 与目录，保持总页数',async()=>{
    const diagram='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 300"><rect x="40" y="40" width="240" height="160" rx="22" fill="#bed6a7"/><path d="M320 120H480" stroke="#bed6a7" stroke-width="4"/><text x="540" y="130" fill="#e8efdf" font-size="32">原因与结果</text></svg>';
    const slides=[
      {name:'知识的生长',elements:[{type:'text',x:120,y:160,w:1300,h:260,text:'用数学，看见增长',style:{fontSize:'100px'}},{type:'text',x:130,y:500,w:1400,h:100,text:'质量与能量满足 $E=mc^2$。',style:{fontSize:'42px'}}]},
      {name:'探索路径',navigation:{style:'petals',title:'让理解，\n逐瓣展开',chapters:[{title:'认识增长',slideIndex:2},{title:'解释关系',slideIndex:4},{title:'表达知识',slideIndex:5}]}},
      {name:'认识增长',elements:[{type:'text',x:120,y:130,w:1600,h:150,text:'用公式写清一个关系',style:{fontSize:'84px'}},{type:'math',latex:String.raw`N(t)=\frac{K}{1+A e^{-rt}}`,x:160,y:390,w:1500,h:220,style:{fontSize:'84px'}}]},
      {name:'模型与图解',elements:[{type:'svg',svg:diagram,x:160,y:240,w:1500,h:560}]},
      {name:'解释关系',html:'<div class="wpx-el" data-wpx-el="marked-math" data-wpx-type="html" style="left:130px;top:290px;width:1600px;height:300px;font-size:80px"><div data-wds-latex="\\frac{dN}{dt}=rN">source</div></div>'},
      {name:'表达知识',elements:[{type:'text',x:120,y:200,w:1550,h:300,text:'从全貌，走向理解。',style:{fontSize:'110px'}}]},
    ];
    const result=await exec('deck_compose',{direction:'celadon',slides});assert(result.ok,result.error);assert.equal(result.pages,6);
    assert.equal(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelectorAll('.wpx-slide').length`),6);
    assert.equal(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelectorAll('.katex').length`),3);
    assert.equal(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelectorAll('[data-wds-svg] svg').length`),1);
    await ev(`window.__WDS__.getEditor().saveNow({reason:'qa-rich-compose'})`);
  });
  await step('目录替换保留页面外壳、目标 ID 在页序调整后有效',async()=>{
    for(const style of ['orbit','steps','petals']){
      const result=await exec('deck_set_navigation',{index:1,style,title:'让理解，\n逐瓣展开',chapters:[{title:'认识增长',slideIndex:2},{title:'解释关系',slideIndex:4},{title:'表达知识',slideIndex:5}]});assert(result.ok,result.error);
      assert.equal(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelectorAll('.wpx-slide').length`),6);
    }
    const target=await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelector('[data-wds-target]').dataset.wdsTarget`);
    assert((await exec('deck_move_slide',{from:2,to:3})).ok);
    assert.equal(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelectorAll('.wpx-slide')[3].dataset.id`),target);
    assert(await ev(`(()=>{const d=window.__WDS__.getEditor().iframe.contentDocument;return [...d.querySelectorAll('[data-wds-target]')].every(n=>[...d.querySelectorAll('.wpx-slide')].some(s=>s.dataset.id===n.dataset.wdsTarget))})()`));
    assert((await exec('deck_move_slide',{from:3,to:2})).ok);
  });
  await step('右键元素重做先填写要求，取消不发送，确认只发送一次',async()=>{
    await ev(`window.__WDS__.getEditor().goSlide(0)`);
    await ev(`window.__WDS__.bus.runCommand('app.contextMenu',{designX:250,designY:220,clientX:500,clientY:400})`);
    await until(()=>ev(`!![...document.querySelectorAll('.ctx-item,.ctx-menu-item,button')].find(b=>b.textContent.trim()==='用 AI 重做这个元素')`),'元素右键菜单');
    await ev(`(()=>{const c=window.__WDS__;window.__redoSent=[];window.__originalCommand=c.bus.runCommand.bind(c.bus);c.bus.runCommand=(n,p)=>{if(n==='agent.send'){window.__redoSent.push(p);return {ok:true}}return window.__originalCommand(n,p)};[...document.querySelectorAll('.ctx-menu button')].find(b=>b.textContent.trim()==='用 AI 重做这个元素').click()})()`);
    await until(()=>ev(`!!document.querySelector('.redo-dialog')`),'重做对话框');assert.equal(await ev(`window.__redoSent.length`),0);
    await ev(`[...document.querySelectorAll('.redo-dialog button')].find(b=>b.textContent==='取消').click()`);await sleep(180);assert.equal(await ev(`window.__redoSent.length`),0);
    await ev(`window.__WDS__.bus.runCommand('app.contextMenu',{designX:250,designY:220,clientX:500,clientY:400})`);await sleep(100);
    await ev(`[...document.querySelectorAll('.ctx-menu button')].find(b=>b.textContent.trim()==='用 AI 重做这个元素').click()`);await sleep(100);
    await ev(`document.querySelector('[aria-label="重做要求"]').value='增加留白，保留公式，使用花瓣形状';[...document.querySelectorAll('.redo-dialog button')].find(b=>b.textContent==='发送给 Agent').click()`);
    await until(()=>ev(`window.__redoSent.length===1`),'确认发送');
    assert(await ev(`window.__redoSent[0].text.includes('增加留白，保留公式，使用花瓣形状')&&window.__redoSent[0].text.includes('id:')`));
    await shot('authoring-redo-requirements');await ev(`window.__WDS__.bus.runCommand=window.__originalCommand`);await sleep(180);
  });
  await step('右键页面重做使用同一要求对话框，取消不触发模型',async()=>{
    const count=await ev(`${L}.messages.length`);
    await ev(`window.__WDS__.bus.runCommand('app.contextMenu',{designX:1820,designY:950,clientX:500,clientY:400})`);await sleep(100);
    await ev(`[...document.querySelectorAll('.ctx-menu button')].find(b=>b.textContent.trim()==='让 AI 重做这一页').click()`);await sleep(100);
    assert(await ev(`document.querySelector('.redo-dialog').textContent.includes('重做这一页')`));
    await shot('authoring-redo-page');await ev(`[...document.querySelectorAll('.redo-dialog button')].find(b=>b.textContent==='取消').click()`);await sleep(180);
    assert.equal(await ev(`${L}.messages.length`),count);
  });
  await step('生图默认关闭，取消配置不启用，通用设置拒绝自动开启',async()=>{
    const initial=(await json(base,'/api/settings')).imageGeneration;assert.equal(initial.enabled,false);
    assert.equal((await fetch(base+'/api/projects/'+encodeURIComponent(project.id)+'/generate-image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'leaf'})})).status,403);
    const rejected=await exec('app_call_api',{operation:'settings.write',body:{imageGeneration:{enabled:true}}});assert.equal(rejected.ok,false);
    const direct=await fetch(base+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({imageGeneration:{enabled:true}})});assert.equal(direct.status,403);
    await ev(`void import('/app/js/agent/image-settings.js').then(m=>m.openImageSettings(window.__WDS__))`);await sleep(150);
    await ev(`document.querySelector('[aria-label="允许 Agent 使用生图服务"]').checked=true;[...document.querySelectorAll('.ais-dialog button')].find(b=>b.textContent==='取消').click()`);await sleep(180);
    assert.equal((await json(base,'/api/settings')).imageGeneration.enabled,false);
    assert.equal((await json('http://127.0.0.1:'+modelPort,'/test/image-stats')).generatedImages,0);
  });
  await step('Agent 生图只保存对话素材，按需插入后可随 HTML 导出',async()=>{
    await ev(`void import('/app/js/agent/image-settings.js').then(m=>m.openImageSettings(window.__WDS__))`);await sleep(150);
    await ev(`document.querySelector('[aria-label="生图服务地址"]').value=${JSON.stringify('http://127.0.0.1:'+modelPort+'/v1')};document.querySelector('[aria-label="生图 API Key"]').value='fake-image-secret';document.querySelector('[aria-label="允许 Agent 使用生图服务"]').checked=true;`);
    await ev(`document.querySelector('[aria-label="生图 API Key"]').dispatchEvent(new Event('input',{bubbles:true}))`);
    await until(()=>ev(`document.querySelector('.ais-image-form').textContent.includes('已发现 1 个生图模型')`),'自动获取图像模型');
    await shot('authoring-image-settings');await ev(`[...document.querySelectorAll('.ais-dialog button')].find(b=>b.textContent==='保存').click()`);await sleep(250);
    assert.equal((await json(base,'/api/settings')).imageGeneration.enabled,true);assert(!JSON.stringify(await json(base,'/api/settings')).includes('fake-image-secret'));
    await newChat();const pageBefore=await ev('window.__WDS__.store.get().deck.current');await input('IMAGE_INSERT_TEST');await idle();
    assert(await ev(`${L}.messages.some(m=>m.role==='tool'&&m.name==='deck_generate_image'&&JSON.parse(m.content).ok)`));
    const generatedAsset=await ev(`JSON.parse(${L}.messages.findLast(m=>m.role==='tool'&&m.name==='deck_generate_image').content)`);
    const src=generatedAsset.url,session=await ev(`${L}.getState().sessionId`);assert(src.startsWith('assets/chats/'+session+'/'));assert.equal(generatedAsset.inserted,false);
    assert.equal(await ev('window.__WDS__.store.get().deck.current'),pageBefore);
    assert.equal(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelectorAll('img[src^="assets/chats/"]').length`),0);
    assert((await fetch(base+'/p/'+encodeURIComponent(project.id)+'/'+src)).ok);
    const turn=await ev(`${L}.messages.find(m=>m.role==='user')`);assert(turn.versions[project.id].before);assert(turn.versions[project.id].after);
    await ev(`window.__WDS__.getEditor().bridge.call('go',{index:2})`);
    assert((await exec('deck_insert_image',{src,x:1450,y:700,w:240,h:200})).ok);
    await ev(`window.__WDS__.getEditor().saveNow({reason:'qa-image-placement'})`);
    await until(()=>ev(`(()=>{const img=window.__WDS__.getEditor().iframe.contentDocument.querySelector('img[src^="assets/chats/"]');return img&&img.complete&&img.naturalWidth>0})()`),'按需插入的本地图片载入');
    const html=await (await fetch(base+'/api/projects/'+encodeURIComponent(project.id)+'/export')).text();assert(html.includes('data:image/png;base64'));assert(html.includes('data:font/woff2;base64'));assert(html.includes('data-wds-navigation'));assert(html.includes('go-id:'));
    assert.equal((await json('http://127.0.0.1:'+modelPort,'/test/image-stats')).generatedImages,1);
    const generated=(await json('http://127.0.0.1:'+modelPort,'/test/image-stats')).imagePayloads[0];
    assert.equal(generated.model,'gpt-image-1.5');assert.equal(generated.size,'1536x1024');assert.equal(generated.quality,'high');assert.equal(generated.background,'transparent');assert.equal(generated.output_format,'webp');assert.equal(generated.output_compression,85);
  });
  await step('用户关闭生图后立即禁止后续调用，已有页面内容保留',async()=>{
    await ev(`void import('/app/js/agent/image-settings.js').then(m=>m.openImageSettings(window.__WDS__))`);await sleep(150);
    await ev(`document.querySelector('[aria-label="允许 Agent 使用生图服务"]').checked=false;[...document.querySelectorAll('.ais-dialog button')].find(b=>b.textContent==='保存').click()`);await sleep(250);
    assert.equal((await exec('deck_generate_image',{prompt:'leaf'})).ok,false);
    assert.equal((await fetch(base+'/api/projects/'+encodeURIComponent(project.id)+'/generate-image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'leaf'})})).status,403);
    assert.equal((await json('http://127.0.0.1:'+modelPort,'/test/image-stats')).generatedImages,1);
    await ev(`window.__WDS__.getEditor().saveNow({reason:'qa-image'})`);
  });
  await step('放映中花瓣展开、选中放大进入章节，返回后可再次展开',async()=>{
    await cdp.send('Page.navigate',{url:base+'/p/'+encodeURIComponent(project.id)+'/index.html?wpx=present'});
    await until(()=>ev(`!!window.__WPX__`),'放映运行时');await ev(`window.__WPX__.go(1)`);await sleep(1200);
    assert.equal(await ev(`getComputedStyle(document.querySelector('.is-active [data-wds-target]')).animationName`),'wds-nav-unfold');await shot('authoring-petals-present');
    const target=await ev(`document.querySelector('.is-active [data-wds-target]').dataset.wdsTarget`);
    await ev(`document.querySelector('.is-active [data-wds-target]').click()`);await sleep(200);
    assert(await ev(`document.querySelectorAll('.is-active').length>=1&&document.getAnimations().some(a=>a.effect.getKeyframes().some(k=>(k.transform||'').includes('scale(15)')))`));
    await sleep(1100);assert.equal(await ev(`document.querySelector('.is-active').dataset.id`),target);
    assert(await ev(`!!document.querySelector('.is-active .katex')`));await shot('authoring-math-present');
    await ev(`window.__WPX__.go(1)`);await sleep(1200);assert(await ev(`!!document.querySelector('.is-active [data-wds-navigation]')`));
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await ev(`getComputedStyle(document.querySelector('.is-active [data-wds-target]')).animationName`),'none');
    await ev(`document.querySelector('.is-active [data-wds-target]').click()`);await sleep(1100);assert.equal(await ev(`document.querySelector('.is-active').dataset.id`),target);
    await cdp.send('Emulation.setEmulatedMedia',{features:[]});
  });
  await step('离线导出页面实际渲染公式、SVG、本地配图与目录交互',async()=>{
    const html=await (await fetch(base+'/api/projects/'+encodeURIComponent(project.id)+'/export')).text();
    await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    try {
      await ev(`(()=>{const f=document.createElement('iframe');f.id='portable-test';f.style.cssText='position:fixed;inset:0;width:100%;height:100%;border:0;z-index:99999';f.srcdoc=${JSON.stringify(html)};document.body.append(f)})()`);
      await until(()=>ev(`!!document.querySelector('#portable-test')?.contentWindow?.__WPX__`),'离线放映运行时');
      assert.equal(await ev(`document.querySelector('#portable-test').contentDocument.querySelectorAll('.katex').length`),3);
      assert.equal(await ev(`document.querySelector('#portable-test').contentDocument.querySelectorAll('[data-wds-svg] svg').length`),1);
      await until(()=>ev(`(()=>{const i=document.querySelector('#portable-test').contentDocument.querySelector('img');return i.complete&&i.naturalWidth>0})()`),'离线图片');
      await ev(`document.querySelector('#portable-test').contentWindow.__WPX__.go(1)`);await sleep(1100);
      await ev(`document.querySelector('#portable-test').contentDocument.querySelector('.is-active [data-wds-target]').click()`);await sleep(1100);
      assert(await ev(`!!document.querySelector('#portable-test').contentDocument.querySelector('.is-active .katex')`));
      await shot('authoring-portable-offline');
    } finally {await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});}
  });
  await step('回退后读取中断可重试，图片和文档重新填回输入框', async () => {
    const { project: rewindProject } = await json(base, '/api/projects', { name: '回退附件验收', templateId: 'blank' });
    await cdp.send('Page.navigate', { url: base + '/?qa=1#/p/' + encodeURIComponent(rewindProject.id) });
    await until(() => ev(`window.__WDS__?.getEditor()?.projectId===${JSON.stringify(rewindProject.id)}`), '回退测试工程');
    await ready();
    await ev(`if(document.querySelector('#app').dataset.agent!=='open')window.__WDS__.bus.runCommand('app.toggleAgent')`);
    await ev(`(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['回退附件的原始内容'], '回退资料.md', { type: 'text/markdown' }));
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bZsAAAAASUVORK5CYII='), ch => ch.charCodeAt(0));
      dt.items.add(new File([bytes], '回退图片.png', { type: 'image/png' }));
      const chooser = document.querySelector('.agw-composer input[type=file]');
      chooser.files = dt.files;
      chooser.dispatchEvent(new Event('change'));
    })()`);
    await until(() => ev(`document.querySelectorAll('.agw-file[data-status=ready]').length===2`), '附件读取');
    await input('VERSION_TURN 回退附件验收');
    await idle();
    const original = await ev(`${L}.messages.find(m=>m.role==='user')`);
    assert(original.versions[rewindProject.id].before);
    assert(original.assetPaths[0]);
    await input('FOLLOWUP 待回退消息');
    await idle();
    await ev(`document.querySelector('.agw-user-revert:not(.hidden)').click()`);
    await until(() => ev(`!!document.querySelector('.agw-version-modal .modal-foot .btn--primary')`), '回退确认');
    await ev(`(() => {
      const api = window.__WDS__.api, read = api.getChat;
      api.getChat = async () => {
        api.getChat = read;
        throw new Error('验收模拟：会话读取中断');
      };
    })()`);
    await ev(`document.querySelector('.agw-version-modal .modal-foot .btn--primary').click()`);
    await until(() => ev(`!${L}.getState().loading&&document.querySelector('.agw-error button')?.textContent==='重新读取会话'`), '显示会话重读入口');
    assert.equal(await ev(`${L}.messages.filter(m=>m.role==='user').length`), 2);
    await ev(`document.querySelector('.agw-error button').click()`);
    await until(() => ev(`document.querySelectorAll('.agw-file[data-status=ready]').length===2`), '回填附件');
    assert.equal(await ev(`${L}.messages.length`), 0);
    assert.equal(await ev(`document.querySelector('.agw-input').value`), original.content);
    assert.deepEqual(await ev(`[...document.querySelectorAll('.agw-file strong')].map(el=>el.textContent)`), ['回退资料.md', '回退图片.png']);
    assert.equal(await ev(`document.querySelector('.agw-file img').src`), original.images[0]);
    await input('FOLLOWUP 重发回退附件');
    await idle();
    const resent = await ev(`${L}.messages.find(m=>m.role==='user')`);
    assert.equal(resent.docs[0].text, original.docs[0].text);
    assert.deepEqual(resent.images, original.images);
    assert.deepEqual(resent.assetPaths, original.assetPaths);
    assert((await fetch(base + '/p/' + encodeURIComponent(rewindProject.id) + '/' + resent.assetPaths[0])).ok);
  });
  await step('聊天输入框粘贴的图片会传到手动配置的模型', async () => {
    await ev(`(async () => {
      const ctx = window.__WDS__;
      const settings = await ctx.api.putUserSettings({ providers: [{ id: 'workspace-test', model: 'manual-vision-qa' }] });
      ctx.store.update(s => { s.settings.providers = settings.providers; });
      ctx.agent.loop.setProvider('workspace-test', 'manual-vision-qa');
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bZsAAAAASUVORK5CYII='), ch => ch.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], '粘贴.png', { type: 'image/png' }));
      document.querySelector('.agw-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    await until(() => ev(`!!document.querySelector('.agw-file[data-status=ready] img')`), '粘贴图片预览');
    assert.equal(await ev(`${L}.getState().model`), 'manual-vision-qa');
    assert.equal(await ev(`${L}.getState().modelInfo.vision`), undefined);
    await input('PASTE_IMAGE_QA 请看图片');
    await until(() => ev(`!${L}.streaming&&${L}.messages.at(-1)?.content==='上游已收到实际图片'`), '模型上游收到图片');
  });
  await step('浏览器无 JavaScript 异常',async()=>{assert.deepEqual(report.errors,[]);});
} catch (error) {
  report.fatal=error.stack;console.error(error.stack);process.exitCode=1;
  try{await shot('authoring-features-failure');}catch{}
} finally {
  await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'authoring-features-report.json'),JSON.stringify(report,null,2));
  cdp?.ws.close();for(const child of children.reverse())child.kill();
  console.log(report.steps.filter((s)=>s.ok).length+'/'+report.steps.length+' checks passed');
}
