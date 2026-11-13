/**
 * 附件（PDF / DOCX / 图片）解析与发送验收
 * 用法：node scripts/qa-attachments.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.WDS_BASE || 'http://127.0.0.1:4321';
const DBG = Number(process.env.WDS_DEBUG_PORT || 9344);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MOCK_PORT = 4603;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sse = (res, d) => res.write('data: ' + JSON.stringify(d) + '\n\n');
const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-att', name: 'Mock Att', context_length: 131072, tool_call: true }] }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
  const base = { id: 'a', object: 'chat.completion.chunk', model: 'mock-att', choices: [] };
  sse(res, { ...base, choices: [{ index: 0, delta: { content: '收到附件，已按资料整理。' }, finish_reason: null }] });
  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) { const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); });
  }
}

const userData = path.join(os.tmpdir(), 'wds-att-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + DBG, '--user-data-dir=' + userData, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let project = null;
const cleanup = async () => {
  if (project) { try { await fetch(BASE + '/api/projects/' + encodeURIComponent(project.id), { method: 'DELETE' }); } catch { /* ignore */ } }
  try { await fetch(BASE + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removeProviders: ['mock-att'] }) }); } catch { /* ignore */ }
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
const waitFor = async (expr, timeout = 20000, interval = 300) => {
  const t0 = Date.now();
  for (;;) {
    try { const v = await ev(expr); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > timeout) return null;
    await sleep(interval);
  }
};

const pdfB64 = (await fs.readFile(path.join(ROOT, 'docs/fixtures/test.pdf'))).toString('base64');
const docxB64 = (await fs.readFile(path.join(ROOT, 'docs/fixtures/test.docx'))).toString('base64');
const scanB64 = (await fs.readFile(path.join(ROOT, 'docs/fixtures/scan.pdf'))).toString('base64');
const pngB64 = (await fs.readFile(path.join(ROOT, 'docs/fixtures/test.png'))).toString('base64');

await fetch(BASE + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: [{ id: 'mock-att', name: 'Mock Att', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, keyEnv: 'MOCK_ATT_KEY', wire: 'openai', model: 'mock-att', models: [], apiKey: 'k' }] }) });
const models = await fetch(BASE + '/api/ai/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: 'mock-att' }) }).then((r) => r.json()).catch(() => ({}));
await fetch(BASE + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: [{ id: 'mock-att', model: 'mock-att', models: models.models || [] }] }) });

project = await (await fetch(BASE + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '附件验收', templateId: 'blank' }) })).json().then((d) => d.project || d);
await cdp.send('Page.navigate', { url: BASE + '/?qa=1#/p/' + encodeURIComponent(project.id) });
await sleep(2600);
await ev(`localStorage.setItem('wds:agent:model', JSON.stringify({providerId:'mock-att',model:'mock-att'})); location.reload(); true`);
await waitFor("!!(window.__WDS__ && window.__WDS__.getEditor && window.__WDS__.getEditor().bridge)", 20000);
await ev("window.__WDS__.bus.runCommand('app.toggleAgent')");
await waitFor("document.querySelector('#app').dataset.agent === 'open'", 6000);
await sleep(800);

/* 注入 PDF + DOCX */
const attached = await ev(`(async () => {
  const toFile = (b64, name, type) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new File([u8], name, { type });
  };
  const dt = new DataTransfer();
  dt.items.add(toFile(${JSON.stringify(pdfB64)}, 'fixture.pdf', 'application/pdf'));
  dt.items.add(toFile(${JSON.stringify(docxB64)}, 'fixture.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  dt.items.add(toFile(${JSON.stringify(scanB64)}, 'scan.pdf', 'application/pdf'));
  dt.items.add(toFile(${JSON.stringify(pngB64)}, 'photo.png', 'image/png'));
  const input = document.querySelector('#agent-panel input[type=file]');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  return dt.files.length;
})()`, true);
console.log('已注入文件:', attached);

const ready = await waitFor("(() => { const cards = [...document.querySelectorAll('#agent-panel .agent-attach--doc')]; return cards.length === 3 && cards.every((c) => c.dataset.state === 'ready'); })()", 40000, 400);
const cards = await ev(`[...document.querySelectorAll('#agent-panel .agent-attach--doc')].map((c) => c.innerText.replace(/\\n/g, ' | '))`);
console.log('附件卡片:', JSON.stringify(cards, null, 1));
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
await fs.writeFile(path.join(ROOT, 'docs/shots/attach-01-cards.png'), Buffer.from(shot.data, 'base64'));

/* 发送并检查持久化内容 */
await ev("window.__WDS__.bus.runCommand('agent.send', { text: '按附件资料整理成大纲' }); true");
await waitFor("(() => { const p = document.querySelector('#agent-panel'); return p && !p.querySelector('.agent-send.is-stop') && p.querySelector('.agent-msg--assistant'); })()", 30000, 400);
await sleep(1000);
const msgs = await ev(`(() => { const u = window.__WDS__.store.get().agent.messages.find((m) => m.role === 'user'); return { docs: (u && u.docs || []).map((d) => ({ name: d.name, pages: d.pages, text: (d.text || '').slice(0, 160) })), images: (u && u.images || []).length, assetPaths: (u && u.assetPaths) || [] }; })()`);
console.log('消息附件:', JSON.stringify(msgs, null, 1));

const okPdf = ready && msgs.docs.some((d) => d.name === 'fixture.pdf' && /PDF text extraction test/.test(d.text));
const okDocx = ready && msgs.docs.some((d) => d.name === 'fixture.docx' && /Word 文本抽取/.test(d.text));
const okScan = ready && msgs.docs.some((d) => d.name === 'scan.pdf' && /扫描页/.test(d.text)) && msgs.images >= 2;
const okAsset = msgs.assetPaths.length === 1 && /^assets\//.test(msgs.assetPaths[0]);
console.log('PDF 文字:', okPdf, '| DOCX 文字:', okDocx, '| 扫描页转图片:', okScan, '| 图片数:', msgs.images, '| 素材:', msgs.assetPaths);
console.log(okPdf && okDocx && okScan && okAsset ? '通过：PDF / DOCX / 扫描页 / 图片素材 全链路' : '未通过');
await cleanup();
process.exit(okPdf && okDocx && okScan && okAsset ? 0 : 1);
