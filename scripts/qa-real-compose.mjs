/**
 * 真实模型 deck_compose 端到端验收（临时脚本）
 * 流程：建临时工程 → 无头 Chrome 开编辑器 → Agent 发送创作指令（真实 DeepSeek）→
 *      等待 deck_compose 落页 → 校验页数/动效/转场 → 截图 → 清理。
 * 用法：node scripts/tmp-real-compose.mjs
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = path.join(ROOT, 'docs', 'shots');
const BASE = process.env.WDS_BASE || 'http://127.0.0.1:4321';
const DEBUG_PORT = Number(process.env.WDS_DEBUG_PORT || 9339);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) { const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); return; }
      for (const fn of this.handlers.get(msg.method) || []) fn(msg.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); });
  }
  on(m, f) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(f); }
}

const userData = path.join(os.tmpdir(), 'wds-real-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + userData, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

let project = null;
const cleanup = async () => {
  if (project) { try { await fetch(BASE + '/api/projects/' + encodeURIComponent(project.id), { method: 'DELETE' }); } catch { /* ignore */ } }
  try { chrome.kill(); } catch { /* ignore */ }
};
process.on('uncaughtException', async (e) => { console.error(e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error(e); await cleanup(); process.exit(1); });

let page = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    page = list.find((t) => t.type === 'page');
    if (page) break;
  } catch { /* retry */ }
  await sleep(200);
}
if (!page) { console.error('Chrome 未就绪'); await cleanup(); process.exit(1); }
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');
let firstChatPayload = null;
// 抓首个 /api/ai/chat 请求体，验证 toolChoice 是否下发
cdp.on('Network.requestWillBeSent', (params) => {
  if (!firstChatPayload && params.request && params.request.url.includes('/api/ai/chat')) {
    firstChatPayload = params.request.postData || '';
  }
});

const evalJs = async (expression, awaitPromise = true) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const waitFor = async (expr, timeout = 12000, interval = 400) => {
  const t0 = Date.now();
  for (;;) {
    try { const v = await evalJs(expr); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > timeout) return null;
    await sleep(interval);
  }
};

await fs.mkdir(SHOTS, { recursive: true });

/* 1. 建临时工程（空白模板） */
project = await (async () => {
  const r = await fetch(BASE + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '真实模型验收', templateId: 'blank' }),
  });
  const d = await r.json();
  const p = d.project || d;
  if (!r.ok || !p.id) throw new Error('创建工程失败: ' + JSON.stringify(d).slice(0, 200));
  return p;
})();
console.log('✓ 临时工程', project.id);

/* 2. 打开编辑器 + Agent（DeepSeek 余额不足，走 OpenCode Go 通道） */
await cdp.send('Page.navigate', { url: BASE + '/?qa=1#/p/' + encodeURIComponent(project.id) });
await sleep(2600);
await evalJs(`localStorage.setItem('wds:agent:model', JSON.stringify({providerId:'opencode',model:'deepseek-v4.1-flash'})); location.reload(); true`);
await waitFor("!!(window.__WDS__ && window.__WDS__.getEditor && window.__WDS__.getEditor() && window.__WDS__.getEditor().bridge)", 20000);
await sleep(1500);
await evalJs("window.__WDS__.bus.runCommand('app.toggleAgent')");
await waitFor("document.querySelector('#app').dataset.agent === 'open'", 6000);
await sleep(900);
const modelLabel = await evalJs("document.querySelector('#agent-panel .agent-model-name')?.textContent || ''");
console.log('✓ Agent 面板 · 模型:', modelLabel);
if (/mock/i.test(modelLabel)) { console.error('✗ 仍是 Mock 模型，请先清理'); await cleanup(); process.exit(1); }

/* 3. 发送创作指令（真实模型，走「一句话开演」同款 brief） */
const { buildCreationBrief } = await import(pathToFileURL(path.join(ROOT, 'app', 'js', 'agent', 'blueprints.js')).href);
const creation = buildCreationBrief({ topic: '手冲咖啡入门', directionId: 'aurora', pages: 3 });
await evalJs(`window.__WDS__.bus.runCommand('agent.send', { text: ${JSON.stringify(creation.display)}, brief: ${JSON.stringify(creation.brief)} }); true`);
console.log('✓ 已发送创作 brief（' + creation.display + '），等待真实模型生成（最长 5 分钟）…');

/* 4. 等待 deck_compose 落页：总页数 ≥3 且流式结束 */
const t0 = Date.now();
let done = null;
for (;;) {
  await sleep(2500);
  const st = await evalJs(`(async () => {
    const ed = window.__WDS__.getEditor();
    const s = await ed.bridge.call('getState');
    const streaming = !!document.querySelector('#agent-panel .agent-send.is-stop');
    const tools = [...document.querySelectorAll('#agent-panel .agent-tool')].map((t) => t.dataset.tool + ':' + (t.dataset.state || ''));
    const lastMsg = (document.querySelector('#agent-panel .agent-msg--assistant:last-child') || {}).innerText || '';
    return { total: s.total, streaming, tools, lastMsg: lastMsg.slice(0, 160) };
  })()`).catch(() => null);
  if (st) {
    if (st.total >= 3 && !st.streaming) { done = st; break; }
    if (st.tools.some((t) => /deck_compose:(failed|error)/.test(t))) { done = { ...st, failed: true }; break; }
  }
  if (Date.now() - t0 > 300000) { done = { ...(st || {}), timeout: true }; break; }
}
console.log('  状态:', JSON.stringify(done));
console.log('  首个 chat 请求带 toolChoice:', /toolChoice/.test(firstChatPayload || ''), '· 请求体长度:', (firstChatPayload || '').length);
if (!done || done.failed || done.timeout || done.total < 3) {
  const errTail = await evalJs("([...document.querySelectorAll('#agent-panel .agent-msg')].slice(-2).map((m) => m.innerText.slice(0, 300)))").catch(() => null);
  console.error('✗ 生成未完成。尾部消息:', JSON.stringify(errTail));
  const shot0 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(SHOTS, 'real-compose-fail.png'), Buffer.from(shot0.data, 'base64'));
  await cleanup();
  process.exit(1);
}

/* 5. 保存并校验产物 */
await evalJs("window.__WDS__.bus.runCommand('app.save')");
await sleep(1500);
const meta = await fetch(BASE + '/api/projects/' + encodeURIComponent(project.id)).then((r) => r.json());
const file = await fetch(BASE + '/api/projects/' + encodeURIComponent(project.id) + '/file?path=index.html').then((r) => r.json());
const html = String(file.content || '');
const result = {
  slideCount: meta.project && meta.project.slideCount,
  animCount: (html.match(/data-wpx-anim=/g) || []).length,
  transitionCount: (html.match(/data-wpx-tr-fx=/g) || []).length + (html.match(/data-wpx-tr-in=/g) || []).length,
  tools: done.tools,
};
console.log('✓ 产物校验:', JSON.stringify(result));
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
await fs.writeFile(path.join(SHOTS, 'real-compose.png'), Buffer.from(shot.data, 'base64'));

const ok = result.slideCount >= 3 && result.animCount > 0;
console.log(ok ? '\n通过：真实模型 deck_compose 端到端 OK' : '\n未通过：产物不完整');
await cleanup();
process.exit(ok ? 0 : 1);
