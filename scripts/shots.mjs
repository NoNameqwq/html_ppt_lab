/**
 * 最终视觉截图脚本：文件库 / 新建 / 导入 / 编辑器 / 设计·切换·动画标签 / 历史 / 命令面板 / Agent / 1280×800 / 放映
 * 用法：node scripts/shots.mjs
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = path.join(ROOT, 'docs', 'shots');
const BASE = 'http://127.0.0.1:4321';
const DEBUG_PORT = 9335;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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

const userData = path.join(os.tmpdir(), 'wds-shots-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + userData, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let page = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    page = list.find((t) => t.type === 'page');
    if (page) break;
  } catch { /* retry */ }
  await sleep(200);
}
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
cdp.on('Page.javascriptDialogOpening', () => cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { }));

const evalJs = async (expression, awaitPromise = true) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const goto = async (url, ms = 2200) => { await cdp.send('Page.navigate', { url }); await sleep(ms); };
const waitFor = async (expr, timeout = 10000, interval = 250) => {
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
  console.log('  📸', name);
};
const closeOverlays = async () => {
  await evalJs(`(() => { try { window.__WDS__.dialog.closeAll(); } catch(e){} try { window.__WDS__.overlay.close(); } catch(e){} document.querySelectorAll('.modal-wrap').forEach(n=>n.remove()); return true; })()`).catch(() => { });
  await sleep(280);
};
const openEditor = async (id, ms = 4200) => {
  await goto(BASE + '/?qa=1#/p/' + encodeURIComponent(id), ms);
  await waitFor("document.getElementById('app').dataset.route === 'editor' && !!(window.__WDS__ && window.__WDS__.getEditor && window.__WDS__.getEditor() && window.__WDS__.getEditor().bridge)", 15000);
  await sleep(1400);
  await closeOverlays();
};

const fire = async (expression) => { await evalJs(expression, false); };

await fs.mkdir(SHOTS, { recursive: true });
const projects = (await (await fetch(BASE + '/api/projects')).json()).projects;
const motion = projects.find((p) => p.name.includes('MOTION')) || projects[0];
const bloom = projects.find((p) => p.name.includes('BLOOM')) || projects[1];
const ink = projects.find((p) => p.name.includes('墨韵')) || projects[2];

/* 1. 文件库（浅色 + 深色） */
await goto(BASE + '/?qa=1', 2600);
await waitFor("document.querySelectorAll('#library-view .lib-card:not(.lib-card--skeleton)').length > 0", 10000);
if ((await evalJs("document.documentElement.dataset.theme")) === 'dark') {
  await evalJs("window.__WDS__.bus.runCommand('app.toggleTheme')");
  await sleep(500);
}
await sleep(700);
await shot('final-01-library-light');
await evalJs("window.__WDS__.bus.runCommand('app.toggleTheme')");
await sleep(600);
await shot('final-02-library-dark');
await evalJs("window.__WDS__.bus.runCommand('app.toggleTheme')");
await sleep(400);

/* 2. 新建模板对话框 */
await fire("window.__WDS__.bus.runCommand('file.new')");
await sleep(1500);
await shot('final-03-new-project');
await closeOverlays();

/* 3. 导入对话框 */
await fire("window.__WDS__.bus.runCommand('file.import')");
await sleep(1500);
await shot('final-04-import');
await closeOverlays();

/* 4. 编辑器（墨韵模板） */
await openEditor(ink.id);
await shot('final-05-editor-ink');
const tabs = await evalJs("(() => { try { return (window.__WDS__.ribbon && window.__WDS__.ribbon.getTabs ? window.__WDS__.ribbon.getTabs() : []).map(t => t.id); } catch(e) { return String(e); } })()");
console.log('  ribbon tabs:', JSON.stringify(tabs));
for (const [tab, name] of [['design', 'final-06-tab-design'], ['transitions', 'final-07-tab-transitions'], ['animations', 'final-08-tab-animations']]) {
  await evalJs(`window.__WDS__.bus.emit('ui:tab', { tab: '${tab}' })`);
  await sleep(700);
  await shot(name);
}
await evalJs("window.__WDS__.bus.emit('ui:tab', { tab: 'home' })");
await sleep(300);

/* 5. 历史面板 + 命令面板 */
await fire("window.__WDS__.bus.runCommand('history.open')");
await sleep(900);
await shot('final-09-history');
await closeOverlays();
await fire("window.__WDS__.bus.runCommand('app.commandPalette')");
await sleep(700);
await shot('final-10-palette');
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => { });
await sleep(400);

/* 6. Agent 面板 */
await evalJs("window.__WDS__.bus.runCommand('app.toggleAgent')");
await sleep(900);
await shot('final-11-agent');
await evalJs("window.__WDS__.bus.runCommand('app.toggleAgent')");
await sleep(400);

/* 7. BLOOM 编辑器 */
await openEditor(bloom.id);
await shot('final-12-editor-bloom');

/* 8. 1280×800 */
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(1200);
await shot('final-13-1280x800');
await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => { });

/* 9. 放映（motion 第 1/3 页 + 墨韵模板动画） */
await goto(BASE + '/p/' + encodeURIComponent(motion.id) + '/index.html', 3600);
await waitFor("!!(window.__WPX__ && window.__WPX__.getState)", 12000);
await shot('final-14-present');
let pst = await evalJs("window.__WPX__ ? window.__WPX__.getState() : null");
console.log('  present state:', pst ? pst.current + '/' + pst.total : 'null');
await evalJs("window.__WPX__.go(2, {instant:false}); true", false);
await sleep(1800);
await shot('final-15-present-slide3');
pst = await evalJs("window.__WPX__ ? window.__WPX__.getState() : null");
console.log('  present slide3:', pst ? pst.current + '/' + pst.total : 'null');
const anims = await evalJs("document.getAnimations ? document.getAnimations().length : -1");
console.log('  active animations on slide3:', anims);

/* 10. 墨韵模板放映：封面 → 第 2 页（验证 native 动效） */
await goto(BASE + '/p/' + encodeURIComponent(ink.id) + '/index.html', 3200);
await waitFor("!!(window.__WPX__ && window.__WPX__.getState)", 12000);
await shot('final-16-present-ink-cover');
await evalJs("window.__WPX__.next(); true", false);
await sleep(1600);
await shot('final-17-present-ink-slide2');

console.log('完成。');
chrome.kill();
process.exit(0);
