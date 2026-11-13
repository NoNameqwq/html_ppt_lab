/**
 * 交互回归 QA：鼠标逻辑 / 右键菜单 / 时间线 2.0 / 转场叠加 / 元素交互
 * 用法：node scripts/qa-interaction.mjs
 * 自己创建并删除测试工程，不会污染文件库。
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = 'http://127.0.0.1:4321';
const PORT = 9401;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id); if (!p) return;
        this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); return;
      }
      for (const fn of this.handlers.get(msg.method) || []) fn(msg.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  on(m, f) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(f); }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail != null ? ' → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

const created = await (await fetch(BASE + '/api/projects', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'QA 交互', templateId: 'ink' }),
})).json();
const project = created.project;
console.log('QA 交互 · ' + project.id);

const userData = path.join(os.tmpdir(), 'wds-qa-int-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=' + PORT, '--user-data-dir=' + userData, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let page = null;
for (let i = 0; i < 80; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page'); if (page) break; } catch { /* retry */ }
  await sleep(200);
}
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
const errors = [];
cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') errors.push(p.args.map((a) => a.value || a.description || '').join(' ')); });
cdp.on('Runtime.exceptionThrown', (p) => errors.push('EX ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text)));
const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const waitFor = async (expr, timeout = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await ev(expr).catch(() => false)) return true; await sleep(250); }
  return false;
};
const click = async (x, y, button = 'left') => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
};

try {
  /* ---------- 编辑器 ---------- */
  await cdp.send('Page.navigate', { url: BASE + '/#/p/' + encodeURIComponent(project.id) });
  await waitFor('!!document.querySelector("#deck-frame") && !!window.__WDS__.store.get().deck.ready');
  await sleep(1200);
  const frame = await ev(`(()=>{const f=document.getElementById('deck-frame').getBoundingClientRect();return {x:f.left+f.width/2,y:f.top+f.height/2}})()`);

  const p0 = await ev('window.__WDS__.store.get().deck.current');
  await click(frame.x, frame.y);
  await sleep(800);
  check('编辑画布左键不翻页', p0 === await ev('window.__WDS__.store.get().deck.current'), p0 + ' → ' + await ev('window.__WDS__.store.get().deck.current'));

  await click(frame.x, frame.y, 'right');
  await sleep(700);
  const menu = await ev('!!document.querySelector(".ctx-menu")');
  check('右键弹出自己的菜单', menu, await ev('document.querySelectorAll(".ctx-menu > *").length') + ' 项');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  const info = await ev(`(()=>{const f=document.getElementById('deck-frame').getBoundingClientRect();return {x:f.left+f.width*0.5,y:f.top+f.height*0.45}})()`);
  await click(info.x, info.y, 'right');
  await sleep(700);
  const sub = await ev(`(()=>{const b=[...document.querySelectorAll('.ctx-menu-item')].find(x=>x.textContent.includes('点击行为'));if(!b)return null;const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sub?.x || 10, y: sub?.y || 10 });
  await sleep(300);
  check('元素菜单有「点击行为」二级菜单', await ev('!!document.querySelector(".ctx-menu--sub")'), await ev('document.querySelectorAll(".ctx-menu--sub .ctx-menu-item").length') + ' 项');
  const action = await ev(`(()=>{const b=[...document.querySelectorAll('.ctx-menu--sub .ctx-menu-item')].find(x=>x.textContent.includes('下一页'));if(!b)return null;const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  if (action) { await click(action.x, action.y); await sleep(700); }
  check('点击行为写入 data-wpx-action', /data-wpx-action="next"/.test(await ev(`(async()=>{const b=window.__WDS__.getEditor().bridge;const s=window.__WDS__.store.get().selection;const h=await b.call('getElementHtml',{elementId:s.elementId});return h.html})()`)));

  /* ---------- 字体切换 ---------- */
  await ev(`window.__WDS__.bus.runCommand('text.fontFamily', { family: 'SimSun, serif' })`);
  await sleep(800);
  const font = await ev(`(async () => {
    const ed = window.__WDS__.getEditor();
    const s = window.__WDS__.store.get().selection;
    const sel = await ed.bridge.call('getSelection');
    const frame = [...document.querySelectorAll('iframe')].find((f) => f.clientWidth > 500);
    const el = frame && s ? frame.contentDocument.querySelector('[data-wpx-el="' + s.elementId + '"]') : null;
    const combo = [...document.querySelectorAll('#ribbon .rcombo .rcombo-label')][0];
    return {
      computed: el ? getComputedStyle(el).fontFamily : null,
      storeFam: sel && sel.styles ? sel.styles.fontFamily : null,
      label: combo ? combo.textContent : null,
    };
  })()`);
  check('切换字体生效（画布 + 工具栏回显）', /SimSun/i.test(String(font.computed)) && /SimSun/i.test(String(font.storeFam)) && font.label === '宋体', font);

  /* ---------- 时间线 ---------- */
  await ev('window.__WDS__.bus.runCommand("app.toggleTimeline")');
  await sleep(1500);
  await ev('window.__WDS__.bus.runCommand("timeline.addOverlay",{kind:"flash"})');
  await sleep(1800);
  const tl = await ev(`(async()=>{const b=window.__WDS__.getEditor().bridge;const r=await b.call('getTimeline');return r.timeline})()`);
  check('时间线轨道已创建', tl && tl.tracks.length >= 1, { tracks: tl?.tracks.length, kfs: tl?.tracks?.[0]?.keyframes?.length, pages: tl?.pages?.length });
  const probe = await ev(`(async()=>{const b=window.__WDS__.getEditor().bridge;const t=await b.call('getTimeline');const tl=t.timeline;const p=tl.pages[1];await b.call('timelineSeek',{time:p.start+70});const d=document.querySelector('#deck-frame').contentWindow.document.querySelector('[data-wpx-tl="flash"]');return d?getComputedStyle(d).opacity:null})()`);
  check('分页切换点触发屏闪', Number(probe) > 0.3, 'opacity=' + probe);
  await ev('window.__WDS__.bus.runCommand("app.save")');
  await sleep(1500);
  const html = await fs.readFile(path.join(ROOT, 'projects', project.id, 'index.html'), 'utf8');
  check('时间线已写入 deck', html.includes('id="wpx-timeline"'));

  /* ---------- 放映 ---------- */
  await cdp.send('Page.navigate', { url: BASE + '/p/' + encodeURIComponent(project.id) + '/index.html' });
  await sleep(2800);
  const cur = await ev('window.__WPX__.getState().current');
  await click(900, 520);
  await sleep(1000);
  const cur2 = await ev('window.__WPX__.getState().current');
  check('放映左键翻页', cur2 > cur, cur + ' → ' + cur2);
  await click(900, 520, 'right');
  await sleep(600);
  check('放映右键自定义菜单', await ev('!!document.querySelector(".wpx-ctx")'), await ev('document.querySelectorAll(".wpx-ctx-item,.wpx-ctx-page,.wpx-ctx-chip").length') + ' 项');
  await ev('window.__WPX__.setMouseMode("off")');
  const off0 = await ev('window.__WPX__.getState().current');
  await click(900, 520);
  await sleep(700);
  check('左键「不响应」生效', off0 === await ev('window.__WPX__.getState().current'));
  await ev('window.__WPX__.setMouseMode("advance")');

  /* ---------- 兼容模式 ---------- */
  const raw = (await (await fetch(BASE + '/api/projects')).json()).projects.find((p) => p.kind === 'raw');
  if (raw) {
    await cdp.send('Page.navigate', { url: BASE + '/p/' + encodeURIComponent(raw.id) + '/index.html' });
    await sleep(3000);
    await click(760, 480, 'right');
    await sleep(700);
    check('网页放映右键菜单', await ev('!!document.querySelector(".wpx-ctx")'));
    await ev('window.__WDS_SHELL_TEST__ = 1');
  }
} catch (err) {
  check('脚本执行', false, err.message);
} finally {
  try { await fetch(BASE + '/api/projects/' + encodeURIComponent(project.id), { method: 'DELETE' }); } catch { /* ignore */ }
  check('无 console error', errors.length === 0, errors.slice(0, 3));
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n结果: ${pass} / ${results.length} 通过`);
  chrome.kill();
  process.exit(pass === results.length ? 0 : 1);
}
