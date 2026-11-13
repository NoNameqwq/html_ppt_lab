/**
 * Agent 3.0 界面可视验收（临时）：计划 + 多轮连续工具调用 + 上下文条
 * 用法：node scripts/tmp-ui-agent.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = path.join(ROOT, 'docs', 'shots');
const BASE = process.env.WDS_BASE || 'http://127.0.0.1:4321';
const DBG = 9341;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MOCK_PORT = 4601;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 富工具 Mock ---------- */
const sse = (res, d) => res.write('data: ' + JSON.stringify(d) + '\n\n');
const plan = [
  { title: '读取当前页结构', status: 'done' },
  { title: '统一全册配色', status: 'done' },
  { title: '重排封面版式', status: 'running' },
  { title: '补两处屏闪转场', status: 'pending' },
  { title: '复核页数与动效', status: 'pending' },
];
const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-rich', name: 'Mock Rich', context_length: 131072, tool_call: true, reasoning: true }] }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const toolResults = msgs.filter((m) => m.role === 'tool').length;
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
  const base = { id: 'm', object: 'chat.completion.chunk', model: body.model, choices: [] };
  const toolCall = (id, name, args) => ({ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const emitCalls = async (calls, content) => {
    if (content) sse(res, { ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] });
    await sleep(120);
    sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: calls.map((c, i) => ({ ...c, index: i })) }, finish_reason: null }] });
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  };
  if (toolResults === 0) {
    sse(res, { ...base, choices: [{ index: 0, delta: { reasoning_content: '先列个计划，再按计划读取与修改。' }, finish_reason: null }] });
    return emitCalls([toolCall('c-plan', 'update_plan', { plan })]).catch(() => {});
  }
  if (toolResults === 1) {
    sse(res, { ...base, choices: [{ index: 0, delta: { reasoning_content: '计划已建立，开始读取工程状态和第一页。' }, finish_reason: null }] });
    return emitCalls([
      toolCall('c-state', 'deck_get_state', {}),
      toolCall('c-read', 'deck_read_slide', { index: 0 }),
      toolCall('c-theme', 'deck_set_theme', { theme: 'ink' }),
    ]).catch(() => {});
  }
  sse(res, { ...base, choices: [{ index: 0, delta: { content: '已按计划完成：统一了配色，重排了封面。接下来可以补转场。' }, finish_reason: null }] });
  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

/* ---------- CDP ---------- */
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

const userData = path.join(os.tmpdir(), 'wds-agentui-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=' + DBG, '--user-data-dir=' + userData, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let project = null;
const cleanup = async () => {
  if (project) { try { await fetch(BASE + '/api/projects/' + encodeURIComponent(project.id), { method: 'DELETE' }); } catch { /* ignore */ } }
  try { await fetch(BASE + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removeProviders: ['mock-rich'] }) }); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
  try { mock.close(); } catch { /* ignore */ }
};
process.on('uncaughtException', async (e) => { console.error(e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error(e); await cleanup(); process.exit(1); });

let page = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
    page = list.find((t) => t.type === 'page');
    if (page) break;
  } catch { /* retry */ }
  await sleep(200);
}
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
const evalJs = async (expression, awaitPromise = true) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const waitFor = async (expr, timeout = 12000, interval = 300) => {
  const t0 = Date.now();
  for (;;) {
    try { const v = await evalJs(expr); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > timeout) return null;
    await sleep(interval);
  }
};
const shot = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
};

await fs.mkdir(SHOTS, { recursive: true });
await fetch(BASE + '/api/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ providers: [{ id: 'mock-rich', name: 'Mock Rich', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, keyEnv: 'MOCK_RICH_KEY', wire: 'openai', model: 'mock-rich', models: [], apiKey: 'test-key' }] }),
});
const models = await fetch(BASE + '/api/ai/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: 'mock-rich' }) }).then((r) => r.json()).catch(() => ({}));
await fetch(BASE + '/api/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ providers: [{ id: 'mock-rich', model: 'mock-rich', models: models.models || [] }] }),
});

project = await (async () => {
  const r = await fetch(BASE + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'AgentUI 验收', templateId: 'blank' }),
  });
  const d = await r.json();
  return d.project || d;
})();

await cdp.send('Page.navigate', { url: BASE + '/?qa=1#/p/' + encodeURIComponent(project.id) });
await sleep(2600);
await evalJs(`localStorage.setItem('wds:agent:model', JSON.stringify({providerId:'mock-rich',model:'mock-rich'})); location.reload(); true`);
await waitFor("!!(window.__WDS__ && window.__WDS__.getEditor && window.__WDS__.getEditor() && window.__WDS__.getEditor().bridge)", 20000);
await evalJs("window.__WDS__.bus.runCommand('app.toggleAgent')");
await waitFor("document.querySelector('#app').dataset.agent === 'open'", 6000);
await sleep(900);
await evalJs("window.__WDS__.bus.runCommand('agent.send', { text: '按计划把整套配色统一一下' }); true");

const done = await waitFor("(() => { const t = document.querySelector('#agent-panel'); return t && t.querySelectorAll('.agent-activity').length >= 2 && !t.querySelector('.agent-send.is-stop'); })()", 60000, 400);
await sleep(1500);
const metrics = await evalJs(`(() => {
  const p = document.getElementById('agent-panel');
  const q = (s) => [...p.querySelectorAll(s)];
  const turn = p.querySelector('.agent-msg--assistant');
  return {
    turns: q('.agent-msg--assistant').length,
    rounds: q('.agent-ai-round').length,
    collapsed: !!turn && turn.classList.contains('is-collapsed'),
    fold: (turn && turn.querySelector('.agent-ai-fold-text') || {}).textContent,
    visibleRounds: turn ? [...turn.querySelectorAll('.agent-ai-round')].filter((r) => r.offsetParent !== null).length : 0,
    activities: q('.agent-activity').map((a) => ({ tools: a.querySelectorAll('.agent-tool').length, open: a.classList.contains('is-open'), title: (a.querySelector('.agent-activity-title') || {}).textContent, summary: (a.querySelector('.agent-activity-summary') || {}).textContent, dur: (a.querySelector('.agent-activity-dur') || {}).textContent })),
    plan: (() => { const d = p.querySelector('.agent-plan-dock'); return d ? { visible: !d.classList.contains('hidden'), count: (d.querySelector('.agent-plan-count') || {}).textContent, now: (d.querySelector('.agent-plan-now') || {}).textContent, steps: d.querySelectorAll('.agent-plan-step').length, open: d.classList.contains('is-open') } : null; })(),
    ctx: (p.querySelector('.agent-ctx-label') || {}).textContent,
    errors: window.__ERR__ || [],
  };
})()`);
console.log(JSON.stringify(metrics, null, 1));
await shot('agent3-01-collapsed-turn');
const panelBox = await evalJs(`(() => { const r = document.getElementById('agent-panel').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const clipShot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: panelBox.x, y: panelBox.y, width: panelBox.width, height: panelBox.height, scale: 2 } });
await fs.writeFile(path.join(SHOTS, 'agent3-01-panel.png'), Buffer.from(clipShot.data, 'base64'));

/* 展开整段过程 → 截图 */
await evalJs(`(() => { const b = document.querySelector('#agent-panel .agent-ai-fold'); if (b) b.click(); return true; })()`);
await sleep(500);
await shot('agent3-02-expanded-turn');
const clipShot3 = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: panelBox.x, y: panelBox.y, width: panelBox.width, height: panelBox.height, scale: 2 } });
await fs.writeFile(path.join(SHOTS, 'agent3-02-expanded-panel.png'), Buffer.from(clipShot3.data, 'base64'));

/* 展开多工具组 + 点开一个工具 + 打开上下文详情 */
await evalJs(`(() => {
  const groups = [...document.querySelectorAll('#agent-panel .agent-activity')].filter((g) => !g.classList.contains('hidden'));
  const g = groups.find((x) => x.querySelectorAll('.agent-tool').length > 2) || groups[0];
  const gh = g && g.querySelector('.agent-activity-head');
  if (gh && !g.classList.contains('is-open')) gh.click();
  const th = g && g.querySelector('.agent-tool .agent-tool-head');
  if (th) th.click();
  const c = document.querySelector('#agent-panel .agent-ctx-btn');
  if (c) c.click();
  return true;
})()`);
await sleep(700);
await shot('agent3-03-detail');
const clipShot2 = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: panelBox.x, y: panelBox.y, width: panelBox.width, height: panelBox.height, scale: 2 } });
await fs.writeFile(path.join(SHOTS, 'agent3-03-detail-panel.png'), Buffer.from(clipShot2.data, 'base64'));

/* 工具行细节：局部 3x + 计算样式 */
const actBox = await evalJs(`(() => { const a = document.querySelector('#agent-panel .agent-activity.is-open'); const r = a.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 90) }; })()`);
const clipRow = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...actBox, scale: 3 } });
await fs.writeFile(path.join(SHOTS, 'agent3-04-toolrow.png'), Buffer.from(clipRow.data, 'base64'));
const styleProbe = await evalJs(`(() => {
  const row = document.querySelector('#agent-panel .agent-tool');
  const head = row.querySelector('.agent-tool-head');
  const pick = (el) => { const s = getComputedStyle(el); return { border: s.border, bg: s.backgroundColor, shadow: s.boxShadow, radius: s.borderRadius, h: el.getBoundingClientRect().height, pad: s.padding }; };
  return { row: pick(row), head: pick(head) };
})()`);
console.log('工具行样式:', JSON.stringify(styleProbe));

console.log('saved:', ['agent3-01-collapsed-turn', 'agent3-02-expanded-turn', 'agent3-03-detail'].join(', '));
await cleanup();
process.exit(0);
