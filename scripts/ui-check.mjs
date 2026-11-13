/**
 * UI 改造验收脚本（无头 Chrome + CDP）
 * 检查：顶栏合并 / 字号 / Agent 全高 / Codex 控件（模型·思考强度·工作权限）/ 无提示小字 /
 *      AI 设置分页+高级设置 / 缩略图点击切页 / 动效向快捷提示。
 * 用法：node scripts/ui-check.mjs
 * 产物：docs/shots/ui2-*.png、docs/shots/ui-check.json
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = path.join(ROOT, 'docs', 'shots');
const BASE = process.env.WDS_BASE || 'http://127.0.0.1:4321';
const DEBUG_PORT = Number(process.env.WDS_DEBUG_PORT || 9337);
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

const results = { steps: [], checks: [] };
const record = (name, detail) => { results.steps.push({ name, detail }); console.log('•', name, detail ? JSON.stringify(detail).slice(0, 220) : ''); };
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail }); console.log(ok ? '  ✓' : '  ✗', name, detail ? JSON.stringify(detail).slice(0, 200) : ''); };

const userData = path.join(os.tmpdir(), 'wds-uicheck-' + Date.now());
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
const goto = async (url, ms = 2400) => { await cdp.send('Page.navigate', { url }); await sleep(ms); };
const waitFor = async (expr, timeout = 12000, interval = 200) => {
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
const closeOverlays = async () => {
  await evalJs(`(() => { try { window.__WDS__.dialog.closeAll(); } catch(e){} try { window.__WDS__.overlay.close(); } catch(e){} document.querySelectorAll('.modal-wrap').forEach(n=>n.remove()); return true; })()`).catch(() => { });
  await sleep(300);
};

await fs.mkdir(SHOTS, { recursive: true });

/* 0. 建一个专用验收工程（ink 模板 · 多页 · 空会话），避免依赖/污染真实工程数据，结束后删除 */
const ink = await (async () => {
  const r = await fetch(BASE + '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'UI 验收临时工程', templateId: 'ink' }),
  });
  const data = await r.json();
  const proj = data.project || data;
  if (!r.ok || !proj.id) throw new Error('创建验收工程失败: ' + JSON.stringify(data).slice(0, 200));
  return proj;
})();
const cleanup = async () => {
  try { await fetch(BASE + '/api/projects/' + encodeURIComponent(ink.id), { method: 'DELETE' }); } catch { /* ignore */ }
};
process.on('uncaughtException', async (err) => { console.error(err); await cleanup(); chrome.kill(); process.exit(1); });
process.on('unhandledRejection', async (err) => { console.error(err); await cleanup(); chrome.kill(); process.exit(1); });

/* 1. 文件库 */
await goto(BASE + '/?qa=1', 2600);
await waitFor("document.querySelectorAll('#library-view .lib-card:not(.lib-card--skeleton)').length > 0", 10000);
await sleep(500);
const lib = await evalJs(`(() => {
  const card = document.querySelector('#library-view .lib-card');
  const title = card ? card.querySelector('.lib-card-title') : null;
  const hero = document.querySelector('#library-view h1, #library-view .lib-hero-title, #library-view .lib-title');
  const cs = (el) => el ? parseFloat(getComputedStyle(el).fontSize) : null;
  return {
    bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
    cardTitleFont: cs(title),
    heroFont: cs(hero),
    cards: document.querySelectorAll('#library-view .lib-card:not(.lib-card--skeleton)').length,
    scrollable: document.documentElement.scrollHeight > innerHeight,
  };
})()`);
record('文件库', lib);
check('基础字号 ≥ 14px', lib.bodyFont >= 14, lib.bodyFont);
check('卡片标题字号 ≥ 15px', (lib.cardTitleFont || 0) >= 15, lib.cardTitleFont);
await shot('ui2-01-library');

/* 2. 编辑器 + 顶栏合并 */
await goto(BASE + '/?qa=1#/p/' + encodeURIComponent(ink.id), 3800);
await waitFor("!!(window.__WDS__ && window.__WDS__.getEditor && window.__WDS__.getEditor() && window.__WDS__.getEditor().bridge)", 15000);
await sleep(900);
await closeOverlays();
const layout = await evalJs(`(() => {
  const tb = document.getElementById('titlebar');
  const rb = document.getElementById('ribbon');
  const tabsInTitle = tb ? ['开始','插入','设计','切换','动画','放映','视图','Agent'].filter((t) => (tb.innerText || '').includes(t)) : [];
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const canvasHint = document.getElementById('canvas-hint');
  return {
    titlebar: rect(tb), ribbon: rect(rb), tabsInTitle,
    bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
    hintVisible: !!(canvasHint && canvasHint.offsetHeight > 0 && (canvasHint.innerText || '').trim()),
    statusText: (document.getElementById('statusbar') || {}).innerText || '',
  };
})()`);
record('编辑器布局', layout);
check('Ribbon 标签已并入标题栏（≥6 个）', layout.tabsInTitle.length >= 6, layout.tabsInTitle);
check('标题栏高度约 52px', Math.abs((layout.titlebar?.h || 0) - 52) <= 8, layout.titlebar?.h);
check('Ribbon 内容区高度 ≤ 120px', (layout.ribbon?.h || 0) <= 120, layout.ribbon?.h);
check('画布底部小字提示已移除', !layout.hintVisible, layout.hintVisible);
check('状态栏无操作提示小字', !/提示：|双击元素编辑文字/.test(layout.statusText), layout.statusText.slice(0, 60));
await shot('ui2-02-editor');

/* 3. 点击缩略图切页 */
const clickThumb = async (index) => {
  const box = await evalJs(`(() => {
    const item = document.querySelectorAll('#slide-panel .slide-item')[${index}];
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) return { ok: false, reason: 'no-thumb' };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(1100);
  return await evalJs(`(async () => { const ed = window.__WDS__.getEditor(); const st = await ed.bridge.call('getState'); const active = document.querySelector('#slide-panel .slide-item.is-active'); return { current: st.current, activeIndex: active ? Number(active.dataset.index) : null, pageLabel: (document.querySelector('#statusbar') || {}).innerText || '' }; })()`);
};
const before = await evalJs("(async () => (await window.__WDS__.getEditor().bridge.call('getState')).current)()");
const clicked = await clickThumb(1);
record('点击缩略图', { before, clicked });
check('点击第 2 张缩略图后切到第 2 页', clicked && clicked.current === 1, clicked);
check('缩略图高亮同步', clicked && clicked.activeIndex === 1, clicked && clicked.activeIndex);

/* 4. Agent 面板全高 + Codex 控件 */
await evalJs("window.__WDS__.bus.runCommand('app.toggleAgent')");
await waitFor("document.querySelector('#app').dataset.agent === 'open'", 6000);
await sleep(900);
const agent = await evalJs(`(() => {
  const p = document.getElementById('agent-panel');
  const tb = document.getElementById('titlebar');
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const text = p ? p.innerText : '';
  const buttons = p ? [...p.querySelectorAll('button')].map((b) => (b.innerText || b.getAttribute('aria-label') || b.title || '').trim()).filter(Boolean) : [];
  const hasAny = (arr) => arr.some((t) => text.includes(t) || buttons.some((b) => b.includes(t)));
  return {
    panel: rect(p), titlebar: rect(tb), innerHeight: window.innerHeight, innerWidth: window.innerWidth,
    textSample: text.slice(0, 500),
    hasHintText: /Enter 发送|Shift\+Enter|先读后改|上下文上限|每次修改可撤回/.test(text),
    hasModel: hasAny(['未配置模型', '模型', 'deepseek', 'gpt', 'claude', 'mock']),
    hasEffort: hasAny(['思考', '强度', '自动', '低', '中', '高']),
    hasPermission: hasAny(['权限', '只读', '可编辑', '完全访问', '完全']),
    chips: p ? [...p.querySelectorAll('.agent-chip, .ag-action-title')].map((c) => c.innerText.trim()) : [],
    skillsInComposer: /技能/.test(text),
  };
})()`);
record('Agent 面板', agent);
check('Agent 面板从窗口顶部开始（top≈0）', agent.panel && agent.panel.y <= 2, agent.panel && agent.panel.y);
check('Agent 面板高度 = 视口高度', agent.panel && Math.abs(agent.panel.h - agent.innerHeight) <= 2, { h: agent.panel && agent.panel.h, innerHeight: agent.innerHeight });
check('Agent 打开时标题栏让出宽度', agent.titlebar && agent.titlebar.x + agent.titlebar.w <= agent.panel.x + 2, { tb: agent.titlebar, panel: agent.panel });
check('无 Enter/提示性小字', !agent.hasHintText, agent.hasHintText);
check('存在模型选择器', agent.hasModel, agent.hasModel);
check('存在思考强度', agent.hasEffort, agent.hasEffort);
check('存在工作权限', agent.hasPermission, agent.hasPermission);
check('快捷提示为动效向', agent.chips.length > 0 && agent.chips.some((c) => /动效|转场|入场|粒子|翻转|描边/.test(c)), agent.chips);
await shot('ui2-03-agent');

/* 5. AI 设置分页 + 高级设置 */
await evalJs("window.__WDS__.bus.runCommand('agent.openSettings')", false);
await sleep(1200);
const settings = await evalJs(`(() => {
  const modal = document.querySelector('.modal-wrap .modal');
  if (!modal) return { visible: false };
  const text = modal.innerText;
  const tabs = [...modal.querySelectorAll('[role="tab"], .ais-tab, .ais-provider-tab, .tab, button')].map((b) => b.innerText.trim()).filter((t) => /DeepSeek|OpenCode|自定义/.test(t));
  const apiInputs = modal.querySelectorAll('input[type="password"], input[placeholder*="API"], input[placeholder*="Key"]').length;
  const baseUrlInText = /Base URL|baseUrl/i.test(text);
  const advanced = [...modal.querySelectorAll('button, summary, .ais-advanced-toggle, .ais-advanced-head, [class*="advanced"]')].find((b) => /高级设置/.test(b.innerText || ''));
  return { visible: true, textSample: text.slice(0, 700), tabs, apiInputs, baseUrlInText, hasAdvanced: !!advanced, advancedText: advanced ? advanced.innerText : '' };
})()`);
record('AI 设置', settings);
check('AI 设置弹窗可见', settings.visible, settings.visible);
check('Provider 采用分页/标签', (settings.tabs || []).length >= 2, settings.tabs);
check('内置 Provider 只显示 API Key（Base URL 默认隐藏）', settings.apiInputs >= 1 && !settings.baseUrlInText, { apiInputs: settings.apiInputs, baseUrlInText: settings.baseUrlInText });
check('存在高级设置入口', settings.hasAdvanced, settings.advancedText);
await shot('ui2-04-settings');

/* 5.5 展开高级设置：温度 0.7 / 上下文 100M / 技能管理 */
const advanced = await evalJs(`(async () => {
  const modal = document.querySelector('.modal-wrap .modal');
  if (!modal) return { ok: false };
  const btn = [...modal.querySelectorAll('button, summary, .ais-advanced-toggle, .ais-advanced-head, [class*="advanced"]')].find((b) => /高级设置/.test(b.innerText || ''));
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 500));
  const text = modal.innerText;
  const numInputs = [...modal.querySelectorAll('input[type="number"], input[type="range"]')].map((i) => i.value);
  return { text: text.slice(0, 900), hasTemp: /温度/.test(text), hasContext: /上下文/.test(text), hasSkills: /技能/.test(text), values: numInputs };
})()`);
record('高级设置', advanced);
check('高级设置含温度/上下文/技能管理', advanced.hasTemp && advanced.hasContext && advanced.hasSkills, advanced);
check('温度默认 0.7', (advanced.values || []).some((v) => String(v) === '0.7'), advanced.values);
check('上下文默认 100M', /100000000|100M|100,000,000|1亿/.test(advanced.text || ''), (advanced.text || '').slice(0, 200));
await shot('ui2-05-settings-advanced');
await closeOverlays();
await evalJs("window.__WDS__.bus.runCommand('app.toggleAgent')").catch(() => { });
await sleep(600);

/* 6. 深色 + 1280 */
await evalJs("window.__WDS__.bus.runCommand('app.toggleTheme')");
await sleep(600);
await shot('ui2-06-editor-dark');
await evalJs("window.__WDS__.bus.runCommand('app.toggleTheme')");
await sleep(400);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(900);
await shot('ui2-07-1280');
await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => { });

results.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(SHOTS, 'ui-check.json'), JSON.stringify(results, null, 2), 'utf8');
const failed = results.checks.filter((c) => !c.ok);
console.log('\n检查结果:', results.checks.length - failed.length, '/', results.checks.length, '通过');
if (failed.length) console.log('失败项:', failed.map((f) => f.name).join('、'));
await cleanup();
chrome.kill();
process.exit(failed.length ? 1 : 0);
