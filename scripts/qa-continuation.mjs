/**
 * 自动接续验收（临时）：mock 连续返回 finish_reason=length，检查续写合并
 * 用法：node scripts/tmp-cont-test.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = 'http://127.0.0.1:4321';
const DBG = 9343;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MOCK_PORT = 4602;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PARTS = ['第一段：开场先给出结论。', '第二段：接着说明理由与证据。', '第三段：最后收口并给行动建议。'];
let calls = 0;
const sse = (res, d) => res.write('data: ' + JSON.stringify(d) + '\n\n');
const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-cont', name: 'Mock Cont', context_length: 131072, tool_call: true }] }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
  const base = { id: 'c', object: 'chat.completion.chunk', model: 'mock-cont', choices: [] };
  const idx = Math.min(calls, PARTS.length - 1);
  calls += 1;
  sse(res, { ...base, choices: [{ index: 0, delta: { content: PARTS[idx] }, finish_reason: null }] });
  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: idx < PARTS.length - 1 ? 'length' : 'stop' }] });
  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: idx < PARTS.length - 1 ? 'length' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

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
}

const userData = path.join(os.tmpdir(), 'wds-cont-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + DBG, '--user-data-dir=' + userData, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let project = null;
const cleanup = async () => {
  if (project) { try { await fetch(BASE + '/api/projects/' + encodeURIComponent(project.id), { method: 'DELETE' }); } catch { /* ignore */ } }
  try { await fetch(BASE + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removeProviders: ['mock-cont'] }) }); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
  try { mock.close(); } catch { /* ignore */ }
};
process.on('uncaughtException', async (e) => { console.error(e); await cleanup(); process.exit(1); });

let page = null;
for (let i = 0; i < 60; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json(); page = l.find((t) => t.type === 'page'); if (page) break; } catch { /* retry */ }
  await sleep(200);
}
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
const ev = async (expression, awaitPromise = true) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const waitFor = async (expr, timeout = 30000, interval = 300) => {
  const t0 = Date.now();
  for (;;) {
    try { const v = await ev(expr); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > timeout) return null;
    await sleep(interval);
  }
};

await fetch(BASE + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: [{ id: 'mock-cont', name: 'Mock Cont', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, keyEnv: 'MOCK_CONT_KEY', wire: 'openai', model: 'mock-cont', models: [], apiKey: 'k' }] }) });
const models = await fetch(BASE + '/api/ai/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: 'mock-cont' }) }).then((r) => r.json()).catch(() => ({}));
await fetch(BASE + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: [{ id: 'mock-cont', model: 'mock-cont', models: models.models || [] }] }) });

project = await (await fetch(BASE + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '接续验收', templateId: 'blank' }) })).json().then((d) => d.project || d);
await cdp.send('Page.navigate', { url: BASE + '/?qa=1#/p/' + encodeURIComponent(project.id) });
await sleep(2600);
await ev(`localStorage.setItem('wds:agent:model', JSON.stringify({providerId:'mock-cont',model:'mock-cont'})); location.reload(); true`);
await waitFor("!!(window.__WDS__ && window.__WDS__.getEditor && window.__WDS__.getEditor().bridge)", 20000);
await ev("window.__WDS__.bus.runCommand('app.toggleAgent')");
await waitFor("document.querySelector('#app').dataset.agent === 'open'", 6000);
await sleep(800);
await ev("window.__WDS__.bus.runCommand('agent.send', { text: '写一段三段式说明' }); true");

const done = await waitFor("(() => { const p = document.querySelector('#agent-panel'); return p && !p.querySelector('.agent-send.is-stop') && p.querySelector('.agent-msg--assistant'); })()", 40000, 300);
await sleep(1200);
const out = await ev(`(() => {
  const p = document.getElementById('agent-panel');
  const turn = p.querySelector('.agent-msg--assistant');
  const md = turn ? turn.querySelector('.agent-md') : null;
  const st = window.__WDS__.store.get();
  const asst = (st.agent.messages || []).filter((m) => m.role === 'assistant');
  return {
    streamingDone: !!${JSON.stringify(!!done)},
    rounds: turn ? turn.querySelectorAll('.agent-ai-round').length : 0,
    text: md ? md.innerText.replace(/\\s+/g, ' ').trim() : '',
    contNoteShown: !!p.querySelector('.agent-cont-note'),
    assistantMessages: asst.length,
    persisted: (asst[0] && asst[0].content || '').replace(/\\s+/g, ' ').trim(),
    continuations: st.agent.continuations || 0,
  };
})()`);
console.log(JSON.stringify(out, null, 1));
const pass = out.rounds === 1
  && out.text.includes('第一段') && out.text.includes('第二段') && out.text.includes('第三段')
  && out.assistantMessages === 1;
console.log(pass ? '通过：三段续写合并为一条回答、一个轮次' : '未通过');
await cleanup();
process.exit(pass ? 0 : 1);
