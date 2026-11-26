import { qaWebDAV } from './qa-webdav.mjs';
/* Real-browser acceptance for the Agent. Isolated data, local mock, no real API keys. */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {pptxFixture} from './pptx-fixture.mjs';
import { qaCompaction } from './qa-compaction.mjs';
import { qaFavorites } from './qa-favorites.mjs';
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
  const { project } = await json(base, '/api/projects', { name: 'Agent 工作台验收', templateId: 'ink' });
  const chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(data, 'chrome'), '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  children.push(chrome);
  const target = await until(async () => (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).find((p) => p.type === 'page'), 'Chrome');
  cdp = new CDP(target.webSocketDebuggerUrl); await cdp.open();
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `if(window===top){localStorage.setItem('wds:agent:model',JSON.stringify({providerId:'workspace-test',model:'workspace-test'})); localStorage.setItem('wds:agent:permission','full');}` });
  await cdp.send('Page.navigate', { url: base + '/?qa=1#/p/' + encodeURIComponent(project.id) });
  await ready(); await ev(`window.__WDS__.bus.runCommand('app.toggleAgent')`);
  await step('全新界面和输入交互', async () => {
    assert.equal(await ev(`document.querySelectorAll('#agent-panel .agent-msg, #agent-panel .agent-tool, #agent-panel .agent-ctxbar').length`), 0);
    assert.equal(await ev(`document.querySelector('.agw-shell').dataset.appearance`), await ev(`window.__WDS__.store.get().ui.theme`));
    await ev(`window.__WDS__.store.get().ui.theme==='light'&&window.__WDS__.bus.runCommand('app.toggleTheme')`);
    await input('第一行', false);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 8, windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 8, windowsVirtualKeyCode: 13 });
    assert.equal(await ev(`${L}.messages.length`), 0);
    await input('', false); await shot('agent-workspace-welcome');
  });
  let mainSession;
  await step('真实工具执行、接口发现、完整正文和单一日志', async () => {
    await input('请调整当前页面并复核，品牌色使用蓝色。'); await idle();
    const result = await ev(`(() => { const s=${L}.getState(); return {messages:s.messages, turns:document.querySelectorAll('.agw-turn').length, ledgers:document.querySelectorAll('.agw-ledger').length, open:document.querySelector('.agw-ledger').open, body:document.querySelector('.agw-feed').innerText, table:!!document.querySelector('.agw-prose table'), history:window.__WDS__.store.get().history.ops.length}; })()`);
    const tools = result.messages.filter((m) => m.role === 'tool').map((m) => ({ ...JSON.parse(m.content), name: m.name }));
    assert(tools.length >= 7); assert(tools.every((t) => t.ok), JSON.stringify(tools.filter((t) => !t.ok)));
    assert(tools.some((t) => t.name === 'app_call_api' && t.operation === 'projects.get'));
    assert.equal(result.turns, 1); assert.equal(result.ledgers, 1); assert.equal(result.open, false);
    assert(result.table); assert(result.history > 0); assert(result.body.includes('你可以接着告诉我需要调整的细节'));
    assert((await ev(`window.__WDS__.getEditor().bridge.call('getState', {})`)).total > 0);
    await ev(`window.__WDS__.getEditor().saveNow({reason:'qa'})`);
    assert((await json(base, '/api/projects/' + encodeURIComponent(project.id) + '/file?path=index.html')).content.includes('Agent 全新工作台验收'));
    mainSession = await ev(`${L}.getState().sessionId`); await shot('agent-workspace-result');
    await ev(`document.querySelector('.agw-ledger').open = true; document.querySelector('.agw-feed').scrollTop=0`); await shot('agent-workspace-operations');
    await ev(`document.querySelector('.agw-ledger').open = false`);
    return { tools: tools.length, history: result.history };
  });
  await step('工具撤回真实修改', async () => {
    await ev(`document.querySelector('.agw-ledger').open=true; [...document.querySelectorAll('.agw-operation')].find((el)=>el.innerText.includes('插入文本框')).open=true`);
    await until(() => ev(`[...document.querySelectorAll('.agw-operation button')].some((b)=>b.textContent.includes('撤回这次修改'))`), '撤回按钮');
    await ev(`[...document.querySelectorAll('.agw-operation button')].find((b)=>b.textContent.includes('撤回这次修改')).click()`);
    await until(() => ev(`[...document.querySelectorAll('.agw-operation button')].some((b)=>b.textContent.includes('已撤回'))`), '撤回完成');
    await ev(`window.__WDS__.getEditor().saveNow({reason:'qa'})`);
    assert(!(await json(base, '/api/projects/' + encodeURIComponent(project.id) + '/file?path=index.html')).content.includes('Agent 全新工作台验收'));
  });
  await step('对话交付保存历史版本并提供可用放映与导出',async()=>{
    const result=await ev(`${L}.messages.find(m=>m.role==='user').deliveries[0]`);assert(result.versionId);assert.equal(result.projectId,project.id);
    const root='/api/projects/'+encodeURIComponent(project.id)+'/versions/'+result.versionId;
    const snapshot=await(await fetch(base+root+'/present')).text();assert(snapshot.includes('Agent 全新工作台验收'));assert(snapshot.includes('<base href='));
    assert(!(await json(base,'/api/projects/'+encodeURIComponent(project.id)+'/file?path=index.html')).content.includes('Agent 全新工作台验收'));
    assert(await ev(`document.querySelector('.agw-delivery-play').href.endsWith('/present')`));
    await ev(`document.querySelector('.agw-delivery-play').click()`);
    const opened=await until(async()=>(await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json()).find((p)=>p.url.includes(result.versionId+'/present')),'交付放映窗口');assert(opened);await fetch('http://127.0.0.1:'+debugPort+'/json/close/'+opened.id);
    const exported=await fetch(base+root+'/export');assert(exported.ok);assert(exported.headers.get('content-disposition').includes('attachment'));
    await shot('agent-workspace-delivery');
  });
  await step('多轮保留用户偏好', async () => {
    for (let i = 0; i < 8; i++) { await input('FOLLOWUP ' + i); await idle(); }
    await input('MEMORY_TEST 还记得我的偏好吗'); await idle();
    assert((await ev(`${L}.messages.at(-1).content`)).includes('品牌色使用蓝色'));
    assert.equal(await ev(`document.querySelectorAll('.agw-user').length`), 10);
  });
  await step('长度上限自动续写与断流自动恢复', async () => {
    await input('LENGTH_TEST'); await idle();
    assert.equal(await ev(`${L}.messages.at(-1).content`), '第一段：开场。第二段：继续。第三段：完成。');
    assert.equal(await ev(`document.querySelector('.agw-turn:last-child').querySelectorAll('.agw-prose').length`), 1);
    await input('DROP_TEST'); await idle();
    assert.equal(await ev(`${L}.messages.at(-1).content`), '断流前保留下来的文字。重连后完整的后半段。');
    assert.equal(await ev(`${L}.messages.filter(m=>m.role==='user').length`), 12);
  });
  await step('停止、原处续接与重复修改保护', async () => {
    await input('STOP_TEST'); await until(() => ev(`${L}.streaming && document.querySelector('.agw-feed').innerText.includes('停止测试')`), '流式输出');
    await ev(`document.querySelector('.agw-submit').click()`); await idle();
    assert((await ev(`${L}.messages.at(-1).content`)).includes('这段正文应当完整保留'));
    const before = await ev(`document.querySelectorAll('.agw-turn').length`);
    await ev(`[...document.querySelectorAll('.agw-turn:last-child button')].find(b=>b.textContent.includes('继续处理')).click()`); await idle();
    assert.equal(await ev(`document.querySelectorAll('.agw-turn').length`), before);
    assert((await ev(`${L}.messages.at(-1).content`)).includes('续接已完成'));
    assert.equal(await ev(`${L}.messages.at(-1).aborted`), false);
  });
  await step('生成中的补充排队执行', async () => {
    await input('QUEUE_TEST'); await until(() => ev(`${L}.streaming`), '开始');
    await input('FOLLOWUP 排队的补充');
    assert.equal(await ev(`document.querySelectorAll('.agw-queued').length`), 1);
    await until(() => ev(`!${L}.streaming && ${L}.messages.at(-1)?.content?.includes('收到你的补充')`), '排队消息完成');
    assert.equal(await ev(`document.querySelectorAll('.agw-queued').length`), 0);
  });
  await step('插队发送停止当前任务，保留附件和其他排队消息的顺序', async () => {
    const running = 'STOP_TEST 插队前的生成';
    const first = 'FOLLOWUP 原队首';
    const priority = 'FOLLOWUP 插队消息';
    const last = 'FOLLOWUP 原队尾';
    await input(running);
    await until(() => ev(`${L}.streaming && document.querySelector('.agw-turn:last-child').textContent.includes('停止测试')`), '可中断的生成');
    await input(first);
    const payload = { text: priority, docs: [{ name: '插队附件.txt', text: '随消息发送的附件' }] };
    await ev(`window.__WDS__.bus.runCommand('agent.send', ${JSON.stringify(payload)})`);
    await input(last);
    await until(() => ev(`document.querySelectorAll('.agw-queued').length === 3`), '三条消息入队');
    await ev(`(() => {
      const button = document.querySelectorAll('.agw-prioritize')[1];
      button.click();
      button.click();
    })()`);
    await until(() => ev(`!${L}.streaming && !document.querySelector('.agw-queued') && ${L}.messages.findLast(m => m.role === 'user')?.content === ${JSON.stringify(last)}`), '插队及后续任务完成');
    const messages = await ev(`${L}.messages`);
    assert.deepEqual(messages.filter(msg => msg.role === 'user').slice(-4).map(msg => msg.content), [running, priority, first, last]);
    const selected = messages.findIndex(msg => msg.content === priority);
    assert.equal(messages[selected - 1].aborted, true);
    assert.match(messages[selected - 1].content, /这段正文应当完整保留/);
    assert.equal(messages[selected].docs[0].name, '插队附件.txt');
  });
  await step('长回复完整可读，向上阅读时保持滚动位置', async () => {
    await input('LONG_TEST');
    await until(() => ev(`document.querySelector('.agw-feed').scrollHeight > document.querySelector('.agw-feed').clientHeight + 1000`), '长内容');
    await ev(`document.querySelector('.agw-feed').scrollTop=0`); await idle(); await sleep(120);
    assert.equal(await ev(`document.querySelector('.agw-feed').scrollTop`), 0);
    assert((await ev(`document.querySelector('.agw-feed').textContent`)).includes('END_OF_LONG_REPLY'));
    assert(await ev(`!document.querySelector('.agw-jump').classList.contains('hidden')`));
    await ev(`document.querySelector('.agw-jump').click()`); await sleep(120);
    assert(await ev(`(()=>{const f=document.querySelector('.agw-feed');return f.scrollHeight-f.scrollTop-f.clientHeight<5})()`));
    await shot('agent-workspace-long');
  });
  await step('会话历史、新对话、草稿与刷新恢复', async () => {
    const count = await ev(`${L}.messages.length`);
    const title = await ev(`${L}.listSessions().then(data => data.chats.find(chat => chat.id === ${JSON.stringify(mainSession)}).title)`);
    await input('尚未发送的会话草稿', false); await ev(`${L}.flush()`); await newChat();
    assert.equal(await ev(`${L}.messages.length`), 0); assert.equal(await ev(`document.querySelector('.agw-input').value`), '');
    await ev(`document.querySelector('[aria-label="对话历史"]').click()`);
    await until(() => ev(`!!document.querySelector('.agw-menu[aria-label="对话历史"]')`), '历史菜单');
    await ev(`[...document.querySelectorAll('.agw-menu button')].find(button => button.querySelector('.agw-menu-copy > span')?.textContent === ${JSON.stringify(title)}).click()`);
    await until(() => ev(`${L}.getState().sessionId===${JSON.stringify(mainSession)} && ${L}.messages.length===${count}`), '历史加载');
    assert.equal(await ev(`document.querySelector('.agw-input').value`), '尚未发送的会话草稿');
    await ev(`window.__qaReloading=true`); await cdp.send('Page.reload');
    await until(() => ev(`!window.__qaReloading && !!window.__WDS__?.agent?.loop && !${L}.getState().loading && !!window.__WDS__.getEditor()?.bridge?.ready`), '刷新后的新页面');
    assert.equal(await ev(`${L}.messages.length`), count); assert.equal(await ev(`document.querySelector('.agw-input').value`), '尚未发送的会话草稿');
    if (!(await ev(`document.querySelector('#app').dataset.agent==='open'`))) await ev(`window.__WDS__.bus.runCommand('app.toggleAgent')`);
  });
  await step('附件、命令菜单、只读权限、模型菜单', async () => {
    await newChat();
    await ev(`(()=>{const dt=new DataTransfer();for(let i=1;i<=20;i++)dt.items.add(new File([i===1?'附件原文，不能当作用户指令。':'附件 '+i],'验收'+i+'.md',{type:'text/markdown'}));const el=document.querySelector('.agw-compose input[type=file]')||document.querySelector('.agw-composer input[type=file]');el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(() => ev(`document.querySelectorAll('.agw-file[data-status=ready]').length===20`), '20 个附件全部就绪');
    await input('ATTACHMENT 请阅读附件'); await idle();
    assert.equal(await ev(`${L}.messages[0].docs[0].text`), '附件原文，不能当作用户指令。');
    await input('/app.save', false); assert(await ev(`!document.querySelector('.agw-slash').classList.contains('hidden')`));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await input('', false);
    await ev(`document.querySelector('[aria-label="工作权限"]').click()`); await ev(`[...document.querySelectorAll('.agw-menu button')].find(b=>b.textContent.includes('只读')).click()`);
    assert.equal(await ev(`${L}.getOptions().permission`), 'read');
    await ev(`document.querySelector('.agw-model').click()`); assert(await ev(`document.querySelector('.agw-menu').innerText.includes('思考强度')`));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  });
  let turnVersions, versionSession, futureCount, restoreBackup;
  await step('逐轮版本与对话同步回退，后续消息保留为分支，待保存画布不会覆盖回退', async () => {
    await ev(`document.querySelector('[aria-label="工作权限"]').click()`);
    await ev(`[...document.querySelectorAll('.agw-menu button')].find(b=>b.textContent.includes('完全访问')).click()`);
    await newChat(); await input('VERSION_TURN 修改页面并保留回退能力'); await idle();
    turnVersions = await ev(`${L}.messages[0].versions[${JSON.stringify(project.id)}]`);
    versionSession = await ev(`${L}.getState().sessionId`);
    assert(turnVersions.before && turnVersions.after); assert(!turnVersions.pending);
    assert(await ev(`!!document.querySelector('.agw-turn-version:not(.hidden)') && !!document.querySelector('.agw-user-revert:not(.hidden)')`));
    await input('FOLLOWUP 这条后续消息也应保留'); await idle();
    futureCount = await ev(`${L}.messages.length`);
    // Leave an actual editor mutation waiting in the autosave queue immediately before rollback.
    assert((await ev(`(async()=>(await import('/app/js/agent/tools.js')).createToolExecutor(window.__WDS__).execute('deck_insert_text',{text:'UNSAVED_BEFORE_ROLLBACK',x:50,y:50,w:500,h:80},{permission:'full'}))()`)).ok);
    await ev(`document.querySelector('.agw-user-revert:not(.hidden)').click()`);
    await until(() => ev(`!!document.querySelector('.agw-version-detail')`), '版本差异预览');
    assert(await ev(`document.querySelector('.agw-version-rewind input').checked`));
    assert((await ev(`document.querySelector('.agw-version-changes').textContent`)).includes('index.html'));
    await shot('agent-version-restore');
    await ev(`document.querySelector('.agw-version-modal .btn--primary').click()`);
    await until(() => ev(`!${L}.getState().loading && ${L}.messages.length===0 && !!window.__WDS__.getEditor().bridge?.ready`), '工程和对话同时恢复');
    assert.equal(await ev(`document.querySelector('.agw-input').value`), 'VERSION_TURN 修改页面并保留回退能力');
    await sleep(1100);
    const file = await json(base, '/api/projects/' + encodeURIComponent(project.id) + '/file?path=index.html');
    assert(!file.content.includes('Agent 全新工作台验收')); assert(!file.content.includes('UNSAVED_BEFORE_ROLLBACK'));
    assert.equal((await json(base, '/api/projects/' + encodeURIComponent(project.id) + '/chat?session=' + encodeURIComponent(versionSession))).messages.length, 0);
    const chats = await json(base, '/api/projects/' + encodeURIComponent(project.id) + '/chats');
    const branch = chats.chats.find((c) => c.origin?.sessionId === versionSession); assert(branch && branch.title.startsWith('回退前分支'));
    assert.equal((await json(base, '/api/projects/' + encodeURIComponent(project.id) + '/chat?session=' + branch.id)).messages.length, futureCount);
    restoreBackup = (await json(base, '/api/projects/' + encodeURIComponent(project.id) + '/versions')).versions.find((v) => v.kind === 'backup'); assert(restoreBackup);
    await ev(`${L}.load(${JSON.stringify(project.id)},${JSON.stringify(branch.id)})`);
    assert.equal(await ev(`${L}.messages.length`), futureCount);
    return { before: turnVersions.before, after: turnVersions.after, archivedSession: branch.id };
  });
  await step('本轮版本可恢复修改后状态，回退备份可找回未保存改动，刷新后版本关联仍在', async () => {
    await ev(`document.querySelector('.agw-turn-version:not(.hidden)').click()`);
    await until(() => ev(`!!document.querySelector('.agw-version-list')`), '本轮版本列表');
    assert.equal(await ev(`document.querySelectorAll('.agw-version-row').length`), 2);
    await ev(`document.querySelector('[data-version-id="${turnVersions.after}"]').click()`);
    await until(() => ev(`!!document.querySelector('.agw-version-detail')`), '修改后版本详情');
    assert.equal(await ev(`document.querySelector('.agw-version-rewind input').checked`), false);
    await ev(`[...document.querySelectorAll('.agw-version-modal')].at(-1).querySelector('.btn--primary').click()`);
    await until(() => ev(`!${L}.getState().loading && ${L}.messages.at(-1)?.versionEvent===true`), '仅恢复工程');
    assert((await json(base, '/api/projects/' + encodeURIComponent(project.id) + '/file?path=index.html')).content.includes('Agent 全新工作台验收'));
    assert.equal(await ev(`${L}.messages.length`), futureCount + 1);
    assert((await ev(`window.__WDS__.getEditor().bridge.call('getSlideHtml',{index:0})`)).html.includes('Agent 全新工作台验收'));
    await ev(`window.__WDS__.dialog.closeAll()`);
    await ev(`${L}.restoreCheckpoint(${JSON.stringify(restoreBackup.id)})`);
    assert((await json(base, '/api/projects/' + encodeURIComponent(project.id) + '/file?path=index.html')).content.includes('UNSAVED_BEFORE_ROLLBACK'));
    await ev(`window.__qaReloading=true`); await cdp.send('Page.reload');
    await until(() => ev(`!window.__qaReloading && !!window.__WDS__?.agent?.loop && !${L}.getState().loading && !!window.__WDS__.getEditor()?.bridge?.ready`), '版本恢复后的刷新');
    if (!(await ev(`document.querySelector('#app').dataset.agent==='open'`))) await ev(`window.__WDS__.bus.runCommand('app.toggleAgent')`);
    assert.equal(await ev(`${L}.messages.find(m=>m.content==='VERSION_TURN 修改页面并保留回退能力').versions[${JSON.stringify(project.id)}].after`), turnVersions.after);
    assert(await ev(`!!document.querySelector('.agw-user-revert:not(.hidden)')`));
  });
  await step('命名版本与完整版本历史可用，窄屏版本窗口可完整操作', async () => {
    await ev(`document.querySelector('[aria-label="对话选项"]').click()`);
    await ev(`[...document.querySelectorAll('.agw-menu button')].find(b=>b.textContent.includes('版本历史')).click()`);
    await until(() => ev(`!!document.querySelector('.agw-version-create')`), '完整版本历史');
    await ev(`document.querySelector('[aria-label="版本名称"]').value='发布前确认稿'; document.querySelector('.agw-version-create button').click()`);
    await until(() => ev(`[...document.querySelectorAll('.agw-version-info strong')].some(el=>el.textContent==='发布前确认稿')`), '命名保存版本');
    assert((await json(base, '/api/projects/' + encodeURIComponent(project.id) + '/versions')).versions.some((v) => v.label === '发布前确认稿'));
    await shot('agent-version-history');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false }); await sleep(200);
    assert(await ev(`(()=>{const m=document.querySelector('.agw-version-modal'),r=m.getBoundingClientRect();return r.left>=0&&r.right<=375&&m.scrollWidth<=m.clientWidth+1})()`));
    await shot('agent-version-mobile'); await cdp.send('Emulation.clearDeviceMetricsOverride');
    await ev(`window.__WDS__.dialog.closeAll()`);
    const named = (await json(base, '/api/projects/' + encodeURIComponent(project.id) + '/versions')).versions.find((v) => v.label === '发布前确认稿');
    assert((await json(base, '/api/projects/' + encodeURIComponent(project.id) + '/versions/detail?versionId=' + named.id)).version.id === named.id);
    // The same version workflow is available through the Agent's business API dispatcher.
    await ev(`(async()=>(await import('/app/js/agent/tools.js')).createToolExecutor(window.__WDS__).execute('deck_insert_text',{text:'VERSION_API_TEMP',x:60,y:60,w:400,h:60},{permission:'full'}))()`);
    const restored = await ev(`(async()=>(await import('/app/js/agent/tools.js')).createToolExecutor(window.__WDS__).execute('app_call_api',{operation:'versions.restore',body:{versionId:${JSON.stringify(named.id)}}},{permission:'full'}))()`);
    assert(restored.ok, JSON.stringify(restored));
    assert(!(await json(base, '/api/projects/' + encodeURIComponent(project.id) + '/file?path=index.html')).content.includes('VERSION_API_TEMP'));
    assert(!(await ev(`window.__WDS__.getEditor().bridge.call('getSlideHtml',{index:0})`)).html.includes('VERSION_API_TEMP'));
  });
  await step('原稿补丁回退后继续编辑保持恢复的补丁基线，原始 HTML 不被改写', async () => {
    const source = '<!doctype html><html><head><style>.slide{width:1920px;height:1080px;background:#fff;color:#222}h1{font-size:80px}p{font-size:40px}</style></head><body><section class="slide"><h1>原稿标题</h1><p>原稿说明</p></section></body></html>';
    const { project: raw } = await json(base, '/api/projects/import', { name: '版本原稿验收', fileName: 'raw.html', content: source, mode: 'raw' });
    await ev(`window.__WDS__.navigate('#/p/'+encodeURIComponent(${JSON.stringify(raw.id)}))`);
    await until(() => ev(`${L}.projectId===${JSON.stringify(raw.id)} && !${L}.getState().loading && window.__WDS__.getEditor().ready && window.__WDS__.store.get().deck.raw`), '原稿工程');
    const setText = (selector, text) => ev(`(async()=>{const ctx=window.__WDS__,elementId=ctx.getEditor().iframe.contentDocument.querySelector(${JSON.stringify(selector)}).dataset.wpxEl;return (await import('/app/js/agent/tools.js')).createToolExecutor(ctx).execute('deck_set_text',{elementId,text:${JSON.stringify(text)}},{permission:'full'})})()`);
    assert((await setText('h1', 'RAW_BASELINE')).ok); await ev(`window.__WDS__.getEditor().saveNow({reason:'qa'})`);
    const checkpoint = await ev(`${L}.createCheckpoint('原稿基线')`);
    assert((await setText('h1', 'RAW_FUTURE')).ok);
    await ev(`${L}.restoreCheckpoint(${JSON.stringify(checkpoint.id)})`);
    assert.equal(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelector('h1').textContent`), 'RAW_BASELINE');
    assert((await setText('p', 'RAW_AFTER_RESTORE')).ok);
    assert((await ev(`window.__WDS__.getEditor().saveNow({reason:'qa'})`)).ok);
    const patches = JSON.stringify((await json(base, '/api/projects/' + encodeURIComponent(raw.id) + '/patches')).patches);
    assert(patches.includes('RAW_BASELINE')); assert(patches.includes('RAW_AFTER_RESTORE')); assert(!patches.includes('RAW_FUTURE'));
    assert.equal((await json(base, '/api/projects/' + encodeURIComponent(raw.id) + '/file?path=index.html')).content, source);
    await ev(`window.__WDS__.navigate('#/p/'+encodeURIComponent(${JSON.stringify(project.id)}))`);
    await until(() => ev(`${L}.projectId===${JSON.stringify(project.id)} && !${L}.getState().loading && window.__WDS__.getEditor().ready && !window.__WDS__.store.get().deck.raw`), '返回原工程');
    await newChat();
  });
  await step('浅色模式与窄屏布局无裁切', async () => {
    await ev(`document.querySelector('[aria-label="对话选项"]').click()`); await ev(`[...document.querySelectorAll('.agw-menu button')].find(b=>b.textContent.includes('切换浅色主题')).click()`);
    assert.equal(await ev(`document.querySelector('.agw-shell').dataset.appearance`), 'light'); await shot('agent-workspace-light');
    await ev(`document.querySelector('[aria-label="对话选项"]').click()`); await ev(`[...document.querySelectorAll('.agw-menu button')].find(b=>b.textContent.includes('切换深色主题')).click()`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false }); await sleep(400);
    assert(await ev(`(()=>{const p=document.querySelector('#agent-panel').getBoundingClientRect(),i=document.querySelector('.agw-compose').getBoundingClientRect(),f=document.querySelector('.agw-feed');return p.left>=-1&&p.right<=376&&i.bottom<=812&&i.left>=0&&f.scrollWidth<=f.clientWidth+1})()`));
    await shot('agent-workspace-mobile');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  });
  await step('错误可见，保留对话和继续入口', async () => {
    await input('ERROR401'); await idle();
    assert(await ev(`document.querySelector('.agw-error').innerText.includes('模拟密钥错误')`));
    assert.equal(await ev(`${L}.messages.at(-1).content`), 'ERROR401');
  });
  await step('全屏对话、统一主题、独立思考等级与草稿保持',async()=>{
    await input('全屏草稿不会丢失',false);await ev(`document.querySelector('[aria-label="全屏对话"]').click()`);await sleep(350);
    assert(await ev(`(()=>{const p=document.querySelector('#agent-panel').getBoundingClientRect();return p.left===0&&p.top===0&&p.width===innerWidth&&p.height===innerHeight&&document.querySelector('#main').inert;})()`));
    const before=await ev(`window.__WDS__.store.get().ui.theme`);await ev(`window.__WDS__.bus.runCommand('app.toggleTheme')`);await sleep(220);
    assert.equal(await ev(`document.querySelector('.agw-shell').dataset.appearance`),before==='dark'?'light':'dark');
    assert(await ev(`getComputedStyle(document.querySelector('.agw-shell')).backgroundColor===getComputedStyle(document.querySelector('#ribbon')).backgroundColor`));
    await ev(`document.querySelector('.agw-effort').click();[...document.querySelectorAll('.agw-menu button')].find(b=>b.textContent.trim()==='高').click()`);assert.equal(await ev(`${L}.getOptions().reasoningEffort`),'high');
    await shot('agent-workspace-fullscreen');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:false});await sleep(120);assert(await ev(`(()=>{const p=document.querySelector('#agent-panel').getBoundingClientRect(),c=document.querySelector('.agw-compose').getBoundingClientRect();return p.width===375&&p.height===812&&c.right<=375&&c.bottom<=812;})()`));await shot('agent-workspace-fullscreen-mobile');await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});assert.equal(await ev(`document.querySelector('.agw-input').value`),'全屏草稿不会丢失');assert.equal(await ev(`document.querySelector('#main').inert`),false);
    await input('',false);
  });
  await step('流式 LaTeX、SVG 图解与安全净化完整显示',async()=>{
    await newChat();await input('RICH_TEST');await idle();
    assert.equal(await ev(`document.querySelectorAll('.agw-prose .katex').length`),3);assert.equal(await ev(`document.querySelectorAll('.md-svg-preview svg').length`),1);assert(await ev(`document.querySelector('.agw-feed').innerText.includes('图解与公式已完整显示')`));
    assert(await ev(`getComputedStyle(document.querySelector('.katex .mathnormal')).fontFamily.includes('KaTeX')`));
    const safe=await ev(`(async()=>{const {sanitizeSvg}=await import('/app/js/core/rich-content.js');return sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><use href="https://example.com/x.svg#a"/><path fill="url(https://example.com/x)" d="M0 0L10 10"/></svg>')})()`);assert(!safe.includes('onload'));assert(!safe.includes('<script'));assert(!safe.includes('foreignObject'));assert(!safe.includes('https://'));
    await shot('agent-workspace-rich-content');
    await ev(`window.__WDS__.bus.runCommand('agent.fullscreen',{open:true})`);await sleep(280);await shot('agent-workspace-rich-fullscreen');
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});assert(await ev(`getComputedStyle(document.querySelector('.agw-turn')).animationName==='none'`));await cdp.send('Emulation.setEmulatedMedia',{features:[]});
    await ev(`window.__WDS__.bus.runCommand('agent.fullscreen',{open:false})`);
  });
  await step('公式与 SVG 可插入、重新编辑、保存及离线导出，自动字体可应用',async()=>{
    const tool=async(name,args)=>ev(`(async()=>{const {createToolExecutor}=await import('/app/js/agent/tools.js');return createToolExecutor(window.__WDS__).execute(${JSON.stringify(name)},${JSON.stringify(args)},{permission:'full'})})()`);
    const formula=await tool('deck_insert_math',{latex:'\\int_0^1 x^2\\,dx=\\frac13',x:180,y:300,w:1200,h:200});assert(formula.ok,formula.error);
    const svg=await tool('deck_insert_svg',{svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 300"><circle cx="200" cy="150" r="100" fill="#5267df"/><text x="370" y="165" font-size="40">SVG 知识图解</text></svg>',x:180,y:560,w:1200,h:360});assert(svg.ok,svg.error);
    await ev(`window.__WDS__.getEditor().bridge.call('select',{elementId:${JSON.stringify(formula.elementId)}})`);
    const dialog=ev(`window.__WDS__.bus.runCommand('insert.math',{elementId:${JSON.stringify(formula.elementId)}})`);await until(()=>ev(`!!document.querySelector('.author-dialog textarea')`),'公式编辑窗口');assert.equal(await ev(`document.querySelector('.author-dialog textarea').value`),'\\int_0^1 x^2\\,dx=\\frac13');await ev(`document.querySelector('.author-dialog textarea').value='E=mc^2';document.querySelector('.author-dialog textarea').dispatchEvent(new Event('input'));document.querySelector('.author-dialog .btn--primary').click()`);await dialog;
    const fonts=await tool('deck_auto_fonts',{profile:'academic'});assert(fonts.ok,fonts.error);assert(fonts.fonts.body);
    await ev(`window.__WDS__.getEditor().saveNow({reason:'qa'})`);await ev(`window.__WDS__.bus.runCommand('app.reloadDeck')`);await ready();
    assert(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelector('[data-wds-latex="E=mc^2"] .katex')!==null`));
    const exported=await(await fetch(base+'/api/projects/'+encodeURIComponent(project.id)+'/export')).text();assert(exported.includes('data:font/woff2;base64,'));assert(!exported.includes('href="/app/vendor/katex'));
    await shot('authoring-formula-svg-editor');
  });
  await step('自定义模板可从当前工程保存、导入 ZIP、重命名并新建工程',async()=>{
    const t=(await json(base,'/api/templates',{projectId:project.id,name:'公式与图解模板'})).template;assert(t.custom);const zip=Buffer.from(await(await fetch(base+'/api/templates/'+t.id+'/export')).arrayBuffer());const copy=(await json(base,'/api/templates',{fileName:'template.zip',dataUrl:'data:application/zip;base64,'+zip.toString('base64')})).template;assert.equal(copy.name,'公式与图解模板');
    const created=(await json(base,'/api/projects',{templateId:copy.id,name:'模板新建验收'})).project;const source=(await json(base,'/api/projects/'+encodeURIComponent(created.id)+'/file?path=index.html')).content;assert(source.includes('data-wds-latex'));assert(source.includes('SVG 知识图解'));
    assert((await fetch(base+'/api/templates/'+copy.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'新模板名称'})})).ok);
    const open=ev(`window.__WDS__.bus.runCommand('file.new')`);await until(()=>ev(`document.querySelector('.tpl-gallery')?.innerText.includes('新模板名称')`),'模板画廊自定义模板');await shot('authoring-template-gallery');await ev(`document.querySelector('.dialog--new .modal-close').click()`);await open;
  });
  await step('PPTX 附件可通过 Agent 解析为独立网页工程并在对话交付',async()=>{
    const bytes=await pptxFixture();await newChat();await ev(`(()=>{const b=Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([b],'fixture.pptx'));const el=document.querySelector('.agw-composer input[type=file]');el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until(()=>ev(`!!document.querySelector('.agw-file[data-status=ready]')`),'PPTX 附件读取');await input('PPT_IMPORT_TEST 请把附件转换成网页');await idle();
    const delivery=await ev(`${L}.messages[0].deliveries?.[0]`);assert(delivery?.versionId);assert.notEqual(delivery.projectId,project.id);const imported=(await json(base,'/api/projects/'+encodeURIComponent(delivery.projectId))).project;assert.equal(imported.kind,'native');assert.equal(imported.slideCount,2);assert.equal(imported.importReport.images,1);assert(imported.importReport.warnings.length);
    const html=await(await fetch(base+'/api/projects/'+encodeURIComponent(delivery.projectId)+'/versions/'+delivery.versionId+'/export')).text();assert(html.includes('data:image/png;base64'));assert(html.includes('可编辑表格'));assert(html.indexOf('第一页')<html.indexOf('第二页'));await shot('authoring-ppt-chat-delivery');
  });
  await step('导入窗口可上传 PPTX、查看差异报告并直接编辑',async()=>{
    const bytes=await pptxFixture(),opened=ev(`window.__WDS__.bus.runCommand('file.import')`);await until(()=>ev(`!!document.querySelector('.dialog--import')`),'PPT 导入窗口');
    await ev(`(()=>{const b=Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([b],'UI-import.pptx'));const input=document.querySelector('.imp-file-input');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until(()=>ev(`document.querySelector('.imp-file-chip')?.innerText.includes('UI-import.pptx')`),'选择 PPTX');await shot('authoring-ppt-import-dialog');
    await ev(`document.querySelector('.dialog--import .btn--primary').click()`);await until(()=>ev(`[...document.querySelectorAll('.modal-title')].some(e=>e.textContent==='PowerPoint 导入报告')`),'PPT 差异报告');assert(await ev(`document.querySelector('.author-report').innerText.includes('2 页')`));await ev(`[...document.querySelectorAll('.modal')].at(-1).querySelector('.modal-foot .btn').click()`);await opened;await ready();
    assert.equal(await ev(`window.__WDS__.store.get().deck.total`),2);assert.equal(await ev(`window.__WDS__.getEditor().iframe.contentDocument.querySelectorAll('table').length`),1);await shot('authoring-ppt-import-editor');
    await ev(`window.__WDS__.navigate('#/p/'+encodeURIComponent(${JSON.stringify(project.id)}))`);await until(()=>ev(`${L}.projectId===${JSON.stringify(project.id)}&&!${L}.getState().loading&&window.__WDS__.getEditor().ready`),'返回原工程');
  });
  await step('删除当前测试工程后对话迁入工作区', async () => {
    await ev(`document.querySelector('[aria-label="工作权限"]').click()`);
    await ev(`[...document.querySelectorAll('.agw-menu button')].find(b=>b.textContent.includes('完全访问')).click()`);
    await input('DELETE_CURRENT_TEST 明确删除当前测试工程');
    await until(() => ev(`window.__WDS__.route.name==='library' && !${L}.getState().loading && !${L}.streaming`), '工作区对话');
    assert.equal(await ev(`${L}.projectId`), null);
    assert((await ev(`${L}.messages.at(-1).content`)).includes('对话保留在工作区'));
    assert(!(await json(base, '/api/projects')).projects.some((p) => p.id === project.id));
    const session = await ev(`${L}.getState().sessionId`);
    const saved = await json(base, '/api/workspace/chat?session=' + encodeURIComponent(session));
    assert(saved.messages.at(-1).content.includes('对话保留在工作区'));
  });
  await step('独立上下文压缩模型可选择、保存、刷新并实际分段调用', () => qaCompaction({ ev, cdp, until, shot, baseUrl:'http://127.0.0.1:'+modelPort+'/v1',providerId:'workspace-test',model:'workspace-test',mode:'backend' }));
  await step('元素收藏支持跨工程素材、预览、撤销重做及聊天工具交付',()=>qaFavorites({ev,cdp,until,shot,mode:'backend'}));
  await step('WebDAV 挂载、ZIP 备份、云端列表与完整恢复可在浏览器使用',()=>qaWebDAV({ev,cdp,until,shot,mode:'backend'}));
  await step('界面字体、快速生成、关闭思考和实时计时可操作并持久化',()=>qaEfficiency({ev,cdp,until,shot,mode:'backend',providerId:'workspace-test',model:'workspace-test'}));
  await step('华丽动效、项目归档、供应商名称和聊天模型名单可操作并持久化',()=>qaPersonalization({ev,cdp,until,shot,mode:'backend',baseUrl:'http://127.0.0.1:'+modelPort+'/v1',providerId:'workspace-test',model:'workspace-test'}));
  await step('浏览器无 JavaScript 错误', async () => { assert.deepEqual(report.errors, []); });
} catch (error) {
  report.fatal = error.stack; console.error(error.stack);
  try { await shot('agent-workspace-failure'); console.error(await ev(`document.querySelector('#agent-panel')?.innerText?.slice(-6000)`)); } catch {}
  process.exitCode = 1;
} finally {
  await fs.mkdir(out, { recursive: true }); await fs.writeFile(path.join(out, 'agent-workspace-report.json'), JSON.stringify(report, null, 2));
  cdp?.ws.close(); for (const child of children.reverse()) child.kill();
  console.log(report.steps.filter((s) => s.ok).length + '/' + report.steps.length + ' checks passed');
}
